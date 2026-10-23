/* C8 Chat - toolbar status page.
 *
 * Host access is declared in the manifest and granted during installation, so
 * there is nothing to ask for or check here: this page says which build is
 * installed and opens the game.
 */
(function () {
  'use strict';
  var site = 'https://www.castleinfinity.com/';
  var status = document.getElementById('status');
  var button = document.getElementById('open');

  var version = '';
  try { version = chrome.runtime.getManifest().version || ''; } catch (e) { /* no runtime */ }

  status.textContent = 'C8 Chat' + (version ? ' ' + version : '') +
    ' is installed. Open Castle Infinity and reload the tab; the chat panel appears on the page. ' +
    'Use Settings, then Panel, to dock it left or right, or leave it floating.';

  button.addEventListener('click', function () {
    if (chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: site });
      return;
    }
    window.open(site, '_blank');
  });
})();
