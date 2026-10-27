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
  function createGallery(urls, selected) {
    let available = [...new Set(urls)];
    let index = Math.max(0, available.indexOf(selected));
    return {
      get urls() { return [...available]; },
      get index() { return index; },
      get current() { return available[index] || null; },
      select(url) { const next = available.indexOf(url); if (next >= 0) index = next; return this.current; },
      step(direction) { if (available.length) index = (index + direction % available.length + available.length) % available.length; return this.current; },
      remove(url) {
        const current = this.current;
        available = available.filter(item => item !== url);
        const retained = available.indexOf(current);
        index = retained >= 0 ? retained : Math.min(index, Math.max(0, available.length - 1));
        return this.current;
      }
    };
  }
  return { swipeDirection, bindSwipe, createGallery };
})();
if (typeof module !== "undefined" && module.exports) module.exports = CruiserPhotos;
