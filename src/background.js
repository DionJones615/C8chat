/* C8 Chat - toolbar button.
 *
 * Clicking the icon opens the game in a tab that already has it, or a new tab
 * when none is open. The tabs are filtered here rather than with a query URL
 * pattern so the host permission alone is enough (no "tabs" permission).
 */
(function () {
  'use strict';
  var api = globalThis.browser || globalThis.chrome;
  var site = 'https://www.castleinfinity.com/';

  async function openCastleInfinity() {
    var tabs = await api.tabs.query({});
    var tab = tabs.find(function (t) { return (t.url || '').indexOf(site) === 0; });
    if (tab) {
      await api.tabs.update(tab.id, { active: true });
      if (tab.windowId !== undefined) await api.windows.update(tab.windowId, { focused: true });
      return;
    }
    await api.tabs.create({ url: site });
  }

  api.action.onClicked.addListener(openCastleInfinity);
})();
