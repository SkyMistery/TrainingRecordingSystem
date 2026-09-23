// Classic (non-module) script in old-browser syntax, loaded before the app:
// if the Companion page fails on a phone or tablet, the error still reaches
// the app's log, with the browser's user agent.
;(function () {
  var sent = 0
  function report(message) {
    if (sent++ > 5) return
    try {
      var request = new XMLHttpRequest()
      request.open('POST', '/client-error', true)
      request.setRequestHeader('Content-Type', 'text/plain')
      request.send(String(message).slice(0, 2000))
    } catch (e) {}
  }
  window.addEventListener('error', function (event) {
    report((event.message || 'error') + ' @ ' + (event.filename || '') + ':' + (event.lineno || ''))
  })
  window.addEventListener('unhandledrejection', function (event) {
    report('unhandled rejection: ' + (event.reason && (event.reason.stack || event.reason.message || event.reason)))
  })
  // Still the placeholder after a while: the app never started.
  setTimeout(function () {
    var placeholder = document.getElementById('boot-placeholder')
    if (placeholder) {
      report('app did not start after 8 s')
      placeholder.innerHTML =
        'The page could not start in this browser. Update it, or try Chrome, Edge, Firefox or Safari.'
    }
  }, 8000)
})()
