// v2.5.1 - preserve the request context expected by major signed media CDNs.
// These rules only affect requests initiated by this extension to known media hosts.
(async () => {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
  const rules = [
    {
      id: 25001,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
        { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' }
      ]},
      condition: { initiatorDomains: [chrome.runtime.id], requestDomains: ['googlevideo.com'], resourceTypes: ['xmlhttprequest','media','other'] }
    },
    {
      id: 25002,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'Referer', operation: 'set', value: 'https://www.facebook.com/' },
        { header: 'Origin', operation: 'set', value: 'https://www.facebook.com' }
      ]},
      condition: { initiatorDomains: [chrome.runtime.id], requestDomains: ['fbcdn.net'], resourceTypes: ['xmlhttprequest','media','other'] }
    },
    {
      id: 25003,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'Referer', operation: 'set', value: 'https://www.instagram.com/' },
        { header: 'Origin', operation: 'set', value: 'https://www.instagram.com' }
      ]},
      condition: { initiatorDomains: [chrome.runtime.id], requestDomains: ['cdninstagram.com'], resourceTypes: ['xmlhttprequest','media','other'] }
    },
    {
      id: 25004,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'Referer', operation: 'set', value: 'https://vimeo.com/' },
        { header: 'Origin', operation: 'set', value: 'https://vimeo.com' }
      ]},
      condition: { initiatorDomains: [chrome.runtime.id], requestDomains: ['vimeocdn.com','akamaized.net'], resourceTypes: ['xmlhttprequest','media','other'] }
    }
  ];
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map(r => r.id), addRules: rules });
  } catch (e) {
    console.warn('Any Video Downloader: CDN header rules unavailable', e);
  }
})();
