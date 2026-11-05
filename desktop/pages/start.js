// The first start: online with the account, or on this computer only. (A file, not inline: the pages'
// security policy allows only scripts from the app itself.)
if (new URLSearchParams(location.search).has('offline')) document.getElementById('offlineNote').hidden = false;
document.getElementById('online').addEventListener('click', () => window.saydalitiDesktop.setMode('online'));
document.getElementById('local').addEventListener('click', () => window.saydalitiDesktop.setMode('local'));
