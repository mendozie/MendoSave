// Unit fixtures model user intent explicitly. This is not a browser security
// proof: genuine isTrusted, native clicks and keyboard defaults need native QA.
const dom = require('linkedom');
require('../extension/menu.js');
function UserEvent(type, options) {
  const event = new dom.Event(type, options);
  if (type === 'click' || type === 'keydown' || type === 'keyup') {
    Object.defineProperty(event, 'isTrusted', { value: true, configurable: true });
  }
  return event;
}
UserEvent.prototype = dom.Event.prototype;
function parseHTML(...args) {
  const page = dom.parseHTML(...args);
  page.window.HTMLElement.prototype.click = function () {
    this.dispatchEvent(new UserEvent('click', { bubbles: true, cancelable: true }));
  };
  return page;
}
module.exports = { ...dom, parseHTML, UserEvent };
