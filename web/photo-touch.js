"use strict";
const CruiserPhotos = (() => {
  function swipeDirection(dx, dy, elapsed) {
    if (elapsed > 1000 || elapsed < 0 || Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.4) return 0;
    return dx < 0 ? 1 : -1;
  }
  function bindSwipe(element, step) {
    let start = null;
    let suppressClickUntil = 0;
    element.addEventListener("pointerdown", event => {
      suppressClickUntil = 0;
      if (!event.isPrimary) { start = null; return; }
      if (event.pointerType === "mouse" || event.target.closest(".photo-step, #photo-previous, #photo-next")) return;
      start = { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp };
      element.setPointerCapture(event.pointerId);
    });
    element.addEventListener("pointerup", event => {
      if (!start || start.id !== event.pointerId) return;
      const direction = swipeDirection(event.clientX - start.x, event.clientY - start.y, event.timeStamp - start.time);
      start = null;
      if (direction) { suppressClickUntil = event.timeStamp + 500; step(direction); }
    });
    element.addEventListener("pointercancel", () => { start = null; });
    element.addEventListener("lostpointercapture", () => { start = null; });
    // Swiping a card must not also open the gallery. Keyboard activation is unaffected.
    element.addEventListener("click", event => {
      if (event.detail && event.timeStamp < suppressClickUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }
  return { swipeDirection, bindSwipe };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CruiserPhotos;
