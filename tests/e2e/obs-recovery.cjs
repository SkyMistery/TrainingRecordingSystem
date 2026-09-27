// End-to-end test of the app's OBS robustness against the real OBS, in an
// isolated app instance (own settings and sessions folder in %TEMP%):
// 1. the trainer switches OBS to their own profile while the app is connected:
//    starting a session must not write into it;
// 2. a pause in OBS keeps marker times right;
// 3. another scene chosen in OBS during the recording is switched back, and said;
// 4. the app dies while OBS records: started again, it continues the session
//    and the recording ends up in the session folder;
// 5. a recording started from OBS after the session ended never lands in (or
//    replaces the video of) that session, even after the app restarts;
// 6. quitting gives OBS back the trainer's profile, unchanged.
// Needs: the app closed (one app per OBS), OBS idle on the trainer's own profile, TRS_OBS_PASSWORD set.
const { existsSync, readFileSync, readdirSync, rmSync, statSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { OBSWebSocket } = require('obs-websocket-js')
const { check, isolatedSettings, launch, obsPassword, realSettings, report, sleep, waitForState } = require('./lib.cjs')

const PASSWORD = obsPassword()
const PORT = 9339

async function profileParams(obs) {
  const read = async (parameterCategory, parameterName) =>
    (await obs.call('GetProfileParameter', { parameterCategory, parameterName })).parameterValue
  return {
    mode: await read('Output', 'Mode'),
    format: await read('SimpleOutput', 'RecFormat2'),
    encoder: await read('SimpleOutput', 'RecEncoder'),
    quality: await read('SimpleOutput', 'RecQuality')
  }
}

async function main() {
  const obs = new OBSWebSocket()
  await obs.connect('ws://127.0.0.1:4455', PASSWORD)
  if ((await obs.call('GetRecordStatus')).outputActive) throw new Error('OBS is recording: stop it first')
  const own = {
    profile: (await obs.call('GetProfileList')).currentProfileName,
    collection: (await obs.call('GetSceneCollectionList')).currentSceneCollectionName
  }
  if (own.profile === 'IVAO TRS') throw new Error('Put OBS on your own profile first')
  const ownParams = await profileParams(obs)
  console.log('trainer profile:', own.profile, '/', own.collection, JSON.stringify(ownParams))

  const settings = isolatedSettings('recovery', { capture: { ...realSettings().capture, hiddenWindows: [] } })
  const SESSIONS = settings.sessionsDir
  let run = await launch({ name: 'recovery', port: PORT, settings })
  let folderName = null
  try {
    await run.evaluate(
      `window.api.connectObs({ host: '127.0.0.1', port: 4455, password: ${JSON.stringify(PASSWORD)} }).catch((e) => e.message)`
    )
    await waitForState(run.evaluate, (s) => s.obs.status === 'connected' && !s.busy)
    // Closed once normally: Chromium keeps the key that decrypts the saved password
    // in memory until then, and the killed instance below must find it.
    await run.close()
    run = await launch({ name: 'recovery', port: PORT, fresh: false })
    const connected = await waitForState(run.evaluate, (s) => s.obs.status === 'connected' && !s.busy, 30_000)
    check('connects by itself with the saved password', connected.obs.status === 'connected', connected.obs.error)

    // 1. The trainer switches OBS back to their own profile while the app is idle.
    await obs.call('SetCurrentSceneCollection', { sceneCollectionName: own.collection })
    await obs.call('SetCurrentProfile', { profileName: own.profile })
    await sleep(1500)
    await run.evaluate(
      `window.api.startSession({traineeVid:'000000',traineeName:'E2E test',position:'TEST_APP',trainingType:'Recovery',trainerVid:'',date:'2026-09-23'}, true)`
    )
    let s = await waitForState(run.evaluate, (st) => st.recording !== null)
    folderName = s.recording?.folderName
    const during = (await obs.call('GetProfileList')).currentProfileName
    check('recording started after the trainer switched profile', !!folderName, folderName)
    check('the app switched back to its own profile to record', during === 'IVAO TRS', during)
    const program = (await obs.call('GetCurrentProgramScene')).currentProgramSceneName
    check('OBS records the app’s scene', program === 'TRS Recording', program)

    // 2. Pause in OBS: marker times must not advance while paused.
    await sleep(2000)
    await obs.call('PauseRecord')
    await sleep(3000)
    await obs.call('ResumeRecord')
    await sleep(1000)
    await run.evaluate(`window.api.command('addMarker')`)
    s = await waitForState(run.evaluate, (st) => st.recording?.markers.length === 1)
    const pressed = s.recording.markers[0].pressedAtMs
    const obsTime = (await obs.call('GetRecordStatus')).outputDuration
    check(
      'marker time excludes the pause',
      Math.abs(pressed - obsTime) < 1500,
      `marker ${pressed} ms, OBS ${obsTime} ms`
    )

    // 3. Another scene chosen in OBS: put back, and the trainer is told.
    await obs.call('CreateScene', { sceneName: 'E2E other scene' }).catch(() => undefined)
    await obs.call('SetCurrentProgramScene', { sceneName: 'E2E other scene' })
    s = await waitForState(run.evaluate, (st) => (st.recording?.warnings.length ?? 0) > 0, 5000)
    const back = (await obs.call('GetCurrentProgramScene')).currentProgramSceneName
    check('another scene chosen in OBS is switched back', back === 'TRS Recording', back)
    check('and the recording shows a warning', (s.recording?.warnings.length ?? 0) > 0, s.recording?.warnings.at(-1))
    await obs.call('RemoveScene', { sceneName: 'E2E other scene' }).catch(() => undefined)

    // 4. The app dies while OBS keeps recording.
    run.app.kill()
    await run.exited
    await sleep(1500)
    check('OBS keeps recording after the app died', (await obs.call('GetRecordStatus')).outputActive)
    run = await launch({ name: 'recovery', port: PORT, fresh: false })
    s = await waitForState(run.evaluate, (st) => st.recording !== null, 30_000)
    if (
      !check(
        'restarted app continues the same session',
        s.recording?.folderName === folderName,
        s.recording?.folderName
      )
    ) {
      console.log(
        '[e2e] OBS:',
        JSON.stringify(s.obs),
        '\n[e2e] app log:\n',
        run.output().split(/\r?\n/).slice(-30).join('\n')
      )
    }
    check('markers from before are kept', s.recording?.markers.length === 1)
    await sleep(1500)
    await run.evaluate(`window.api.command('addMarker')`)
    s = await waitForState(run.evaluate, (st) => st.recording?.markers.length === 2)
    check(
      'a new marker continues the numbering and the clock',
      s.recording?.markers[1]?.number === 2 && s.recording.markers[1].pressedAtMs > pressed,
      JSON.stringify(s.recording?.markers.map((m) => [m.number, m.pressedAtMs]))
    )

    // 5. Stopped from OBS itself, then OBS records again ("to continue"), then the app restarts.
    await obs.call('StopRecord')
    s = await waitForState(run.evaluate, (st) => st.recording === null)
    check('stopping in OBS ends the session', s.recording === null)
    check('and says so', s.notice?.title === 'OBS stopped the recording', s.notice?.title)
    const sessionFolder = join(SESSIONS, folderName)
    let file = JSON.parse(readFileSync(join(sessionFolder, 'session.json'), 'utf8'))
    check(
      'recording moved into the session folder, session marked as ended',
      file.recording?.file === 'recording.mp4' &&
        Boolean(file.recording?.endedAt) &&
        existsSync(join(sessionFolder, 'recording.mp4')),
      JSON.stringify(file.recording)
    )
    const video = statSync(join(sessionFolder, 'recording.mp4'))
    await sleep(1500)
    const idleDir = (await obs.call('GetRecordDirectory')).recordDirectory
    check('OBS no longer records into the session folder', resolve(idleDir) !== resolve(sessionFolder), idleDir)
    await obs.call('StartRecord')
    await sleep(3000)
    run.app.kill()
    await run.exited
    run = await launch({ name: 'recovery', port: PORT, fresh: false })
    s = await waitForState(run.evaluate, (st) => st.obs.status === 'connected' && !st.busy, 30_000)
    await sleep(2000)
    s = await run.evaluate('window.api.getState()')
    check(
      'a recording started from OBS does not reopen the finished session',
      s.recording === null,
      s.recording?.folderName
    )
    const stray = await obs.call('StopRecord')
    await sleep(1500)
    file = JSON.parse(readFileSync(join(sessionFolder, 'session.json'), 'utf8'))
    const after = statSync(join(sessionFolder, 'recording.mp4'))
    check(
      'the session’s video was not replaced',
      after.size === video.size && after.mtimeMs === video.mtimeMs && file.recording.file === 'recording.mp4',
      `${video.size} → ${after.size}`
    )
    check(
      'only one video in the session folder',
      readdirSync(sessionFolder).filter((n) => n.endsWith('.mp4')).length === 1
    )
    if (stray.outputPath) rmSync(stray.outputPath, { force: true })

    // 6. Quit: OBS goes back to the trainer's profile, which was never changed.
    await run.close()
    await sleep(500)
    const workspace = {
      profile: (await obs.call('GetProfileList')).currentProfileName,
      collection: (await obs.call('GetSceneCollectionList')).currentSceneCollectionName
    }
    check(
      "OBS is back on the trainer's profile",
      workspace.profile === own.profile && workspace.collection === own.collection,
      JSON.stringify(workspace)
    )
    const afterParams = await profileParams(obs)
    check(
      "the trainer's profile settings were not changed",
      JSON.stringify(afterParams) === JSON.stringify(ownParams),
      JSON.stringify(afterParams)
    )
  } finally {
    // Safety net: never leave a test recording running or OBS on the app's profile.
    const status = await obs.call('GetRecordStatus').catch(() => null)
    const dir = (await obs.call('GetRecordDirectory').catch(() => null))?.recordDirectory ?? ''
    if (status?.outputActive && resolve(dir).startsWith(resolve(SESSIONS)))
      await obs.call('StopRecord').catch(() => undefined)
    if (run.app.exitCode === null) await run.close()
    await sleep(1000)
    if ((await obs.call('GetProfileList')).currentProfileName === 'IVAO TRS') {
      await obs.call('SetCurrentSceneCollection', { sceneCollectionName: own.collection }).catch(() => undefined)
      await obs.call('SetCurrentProfile', { profileName: own.profile }).catch(() => undefined)
    }
    await obs.disconnect()
    rmSync(SESSIONS, { recursive: true, force: true })
    rmSync(run.userData, { recursive: true, force: true })
  }
  report()
}

main().catch((error) => {
  console.error('FAILED', error)
  process.exitCode = 1
})
