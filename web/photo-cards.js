/* Keep photo choice while cards are rebuilt during this visit. */
const photoPositions = new Map();
function rememberPhoto(row, url) {
  if (url) photoPositions.set(row.listing_key || row.listing_url, url);
}
function makePhotoMedia(row) {
  const urls = galleryUrls(row);
  const media = text("div", urls.length ? "listing-media" : "listing-media photo-missing", "");
  media.append(text("span", "year-badge", String(row.year)));
  const credit = text("span", "photo-credit", "");
  media.append(credit);
  if (!urls.length) {
    media.prepend(text("span", "photo-placeholder", row.model || "Vehicle"));
    credit.textContent = "Photos unavailable";
    return media;
  }
  const gallery = CruiserPhotos.createGallery(urls, photoPositions.get(row.listing_key || row.listing_url));
  const trigger = text("button", "photo-viewer", "");
  trigger.type = "button";
  const photo = document.createElement("img");
  photo.loading = "lazy"; photo.decoding = "async"; photo.draggable = false; photo.referrerPolicy = "no-referrer";
  trigger.append(photo);
  const counter = text("button", "photo-counter", "");
  counter.type = "button";
  const count = text("span", "photo-count-number", "");
  counter.append(count, text("span", "photo-expand-label", "photos · Expand ⛶"));
  const hint = text("span", "photo-browse-hint", "Swipe to browse · Tap to expand");
  const arrows = [-1, 1].map(direction => {
    const button = text("button", "photo-step photo-" + (direction < 0 ? "previous" : "next"), direction < 0 ? "‹" : "›");
    button.type = "button";
    button.setAttribute("aria-label", (direction < 0 ? "Previous" : "Next") + " photo for " + row.year + " " + vehicleName(row));
    button.addEventListener("click", () => { gallery.step(direction); show(); });
    return button;
  });
  function show() {
    gallery.urls.filter(url => unavailablePhotos.has(url)).forEach(url => gallery.remove(url));
    const total = gallery.urls.length;
    if (!total) {
      trigger.remove(); counter.remove(); hint.remove(); arrows.forEach(button => button.remove());
      if (!media.querySelector(".photo-placeholder")) media.prepend(text("span", "photo-placeholder", row.model || "Vehicle"));
      media.classList.add("photo-missing"); credit.textContent = "Photos unavailable"; return;
    }
    rememberPhoto(row, gallery.current);
    if (photo.getAttribute("src") !== gallery.current) photo.src = gallery.current;
    photo.alt = "Photo " + (gallery.index + 1) + " of " + total + " for " + row.year + " " + vehicleName(row);
    count.textContent = (gallery.index + 1) + " / " + total;
    const label = "Open full-screen gallery, photo " + (gallery.index + 1) + " of " + total + ", " + row.year + " " + vehicleName(row);
    trigger.setAttribute("aria-label", label); counter.setAttribute("aria-label", label);
    hint.textContent = total > 1 ? "Swipe to browse · Tap to expand" : "Tap to view full screen";
    arrows.forEach(button => { button.hidden = total < 2; });
    credit.textContent = photoCredit(row, gallery.current);
  }
  function open() {
    show();
    openGallery(row, gallery.urls, gallery.index, url => { gallery.select(url); show(); });
  }
  photo.addEventListener("error", () => {
    unavailablePhotos.add(gallery.current); gallery.remove(gallery.current); show();
  });
  trigger.addEventListener("click", open);
  counter.addEventListener("click", open);
  trigger.addEventListener("keydown", event => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault(); gallery.step(event.key === "ArrowLeft" ? -1 : 1); show();
    }
  });
  CruiserPhotos.bindSwipe(trigger, direction => { gallery.step(direction); show(); });
  media.append(trigger, ...arrows, counter, hint);
  show();
  return media;
}
