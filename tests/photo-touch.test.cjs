const test = require("node:test");
const assert = require("node:assert/strict");
const { swipeDirection, bindSwipe } = require("../web/photo-touch.js");

test("only deliberate horizontal swipes change photos", () => {
  assert.equal(swipeDirection(-80, 8, 300), 1);
  assert.equal(swipeDirection(80, 8, 300), -1);
  for (const args of [[10, 0, 100], [70, 100, 200], [80, 70, 200], [80, 0, 1100]])
    assert.equal(swipeDirection(...args), 0);
});

function fixture() {
  const handlers = {};
  const steps = [];
  bindSwipe({ addEventListener(name, handler) { handlers[name] = handler; }, setPointerCapture() {} }, step => steps.push(step));
  const emit = (name, changes = {}) => {
    const event = { isPrimary: true, pointerType: "touch", pointerId: 1, clientX: 150, clientY: 10,
      timeStamp: 100, detail: 1, target: { closest: () => null },
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...changes };
    handlers[name](event);
    return event;
  };
  return { steps, emit };
}

test("swipe advances once and suppresses the follow-up click, but a tap still opens photos", () => {
  const { steps, emit } = fixture();
  emit("pointerdown");
  emit("pointerup", { clientX: 50, timeStamp: 300 });
  assert.deepEqual(steps, [1]);
  assert.equal(emit("click", { timeStamp: 310 }).stopped, true);
  assert.equal(emit("click", { timeStamp: 320, detail: 0 }).stopped, undefined);
  emit("pointerdown", { timeStamp: 400 });
  emit("pointerup", { timeStamp: 450 });
  assert.equal(emit("click", { timeStamp: 460 }).stopped, undefined);
  assert.deepEqual(steps, [1]);
});

test("scroll cancellation, pinch gestures, mouse drags, and arrow buttons do not swipe", () => {
  for (const cancel of ["pointercancel", "lostpointercapture"]) {
    const { emit, steps } = fixture();
    emit("pointerdown"); emit(cancel); emit("pointerup", { clientX: 50, timeStamp: 300 });
    assert.deepEqual(steps, []);
  }
  const { emit, steps } = fixture();
  emit("pointerdown"); emit("pointerdown", { isPrimary: false, pointerId: 2 });
  emit("pointerup", { clientX: 50, timeStamp: 300 });
  emit("pointerdown", { pointerType: "mouse" }); emit("pointerup", { clientX: 50, timeStamp: 300 });
  emit("pointerdown", { target: { closest: () => ({}) } }); emit("pointerup", { clientX: 50, timeStamp: 300 });
  assert.deepEqual(steps, []);
});

test("gallery keeps URL selection, wraps in either direction and removes failed images", () => {
  const {createGallery}=require("../web/photo-touch.js");
  const gallery=createGallery(["a","b","b","c"],"b");
  assert.deepEqual(gallery.urls,["a","b","c"]);assert.equal(gallery.index,1);
  assert.equal(gallery.step(1),"c");assert.equal(gallery.step(1),"a");assert.equal(gallery.step(-1),"c");
  gallery.remove("a");assert.equal(gallery.current,"c");assert.equal(gallery.index,1);
  gallery.remove("c");assert.equal(gallery.current,"b");assert.equal(gallery.index,0);
  gallery.remove("b");assert.equal(gallery.current,null);assert.equal(gallery.step(1),null);
});
test("gallery restores selected URL after reorder and falls back when it disappears", () => {
  const {createGallery}=require("../web/photo-touch.js");
  assert.equal(createGallery(["c","a","b"],"b").index,2);
  assert.equal(createGallery(["a","c"],"b").current,"a");
  const gallery=createGallery(["a","b"],"a");gallery.select("b");gallery.select("missing");
  assert.equal(gallery.current,"b");
  const copy=gallery.urls;copy.length=0;assert.equal(gallery.urls.length,2);
});
