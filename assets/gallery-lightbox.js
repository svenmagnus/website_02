/**
 * Full-size photo viewer for profile and Member Pool galleries.
 */
(function (global) {
  let root = null;
  let images = [];
  let index = 0;
  let keyHandler = null;

  function ensureRoot() {
    if (root) return root;

    root = document.createElement("div");
    root.id = "galleryLightbox";
    root.className = "gallery-lightbox";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Photo");

    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "gallery-lightbox-backdrop";
    backdrop.setAttribute("aria-label", "Close");

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "gallery-lightbox-close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.textContent = "×";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "gallery-lightbox-nav gallery-lightbox-prev";
    prevBtn.setAttribute("aria-label", "Previous photo");
    prevBtn.textContent = "‹";

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "gallery-lightbox-nav gallery-lightbox-next";
    nextBtn.setAttribute("aria-label", "Next photo");
    nextBtn.textContent = "›";

    const stage = document.createElement("div");
    stage.className = "gallery-lightbox-stage";
    const img = document.createElement("img");
    img.className = "gallery-lightbox-img";
    img.alt = "";
    stage.appendChild(img);

    const counter = document.createElement("p");
    counter.className = "gallery-lightbox-counter";

    root.append(backdrop, closeBtn, prevBtn, nextBtn, stage, counter);
    document.body.appendChild(root);

    backdrop.addEventListener("click", close);
    closeBtn.addEventListener("click", close);
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showAt(index - 1);
    });
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showAt(index + 1);
    });
    stage.addEventListener("click", (e) => e.stopPropagation());

    return root;
  }

  function normalizeImages(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => {
        if (typeof item === "string") return item.trim();
        return String(item?.url || "").trim();
      })
      .filter(Boolean);
  }

  function updateUi() {
    if (!root) return;
    const img = root.querySelector(".gallery-lightbox-img");
    const prevBtn = root.querySelector(".gallery-lightbox-prev");
    const nextBtn = root.querySelector(".gallery-lightbox-next");
    const counter = root.querySelector(".gallery-lightbox-counter");
    const src = images[index] || "";
    if (img instanceof HTMLImageElement) img.src = src;
    const multi = images.length > 1;
    if (prevBtn instanceof HTMLButtonElement) prevBtn.hidden = !multi;
    if (nextBtn instanceof HTMLButtonElement) nextBtn.hidden = !multi;
    if (counter) {
      counter.hidden = !multi;
      counter.textContent = multi ? `${index + 1} / ${images.length}` : "";
    }
  }

  function showAt(nextIndex) {
    if (!images.length) return;
    index = (nextIndex + images.length) % images.length;
    updateUi();
  }

  function close() {
    if (!root) return;
    root.hidden = true;
    document.body.classList.remove("has-gallery-lightbox-open");
    if (keyHandler) {
      document.removeEventListener("keydown", keyHandler);
      keyHandler = null;
    }
    const img = root.querySelector(".gallery-lightbox-img");
    if (img instanceof HTMLImageElement) img.removeAttribute("src");
  }

  function open({ images: rawImages, startIndex = 0 } = {}) {
    images = normalizeImages(rawImages);
    if (!images.length) return;
    index = Math.min(Math.max(0, startIndex), images.length - 1);
    ensureRoot();
    updateUi();
    root.hidden = false;
    document.body.classList.add("has-gallery-lightbox-open");

    if (!keyHandler) {
      keyHandler = (e) => {
        if (root?.hidden) return;
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          showAt(index - 1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          showAt(index + 1);
        }
      };
      document.addEventListener("keydown", keyHandler);
    }
  }

  global.DualPeerGalleryLightbox = { open, close };
})(window);
