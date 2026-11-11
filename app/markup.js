(function () {
  'use strict';
  // Parse into an inert template and retain only the formatting Rift emits.
  // Attribute values are assigned through the DOM, never interpolated as HTML.
  window.RiftSafeMarkup = function (html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    const allowed = new Set(['A', 'STRONG', 'EM', 'PRE', 'CODE', 'H1', 'H2', 'H3', 'LI', 'BLOCKQUOTE', 'BR']);
    for (const node of [...template.content.querySelectorAll('*')]) {
      if (!allowed.has(node.tagName)) { node.replaceWith(document.createTextNode(node.textContent || '')); continue; }
      const href = node.tagName === 'A' ? node.getAttribute('href') : null;
      for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
      if (href) {
        try {
          const url = new URL(href);
          if (url.protocol === 'https:' || url.protocol === 'http:') {
            node.setAttribute('href', url.href);
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          }
        } catch { /* Invalid links remain plain formatted text. */ }
      }
    }
    return template.innerHTML;
  };
})();
