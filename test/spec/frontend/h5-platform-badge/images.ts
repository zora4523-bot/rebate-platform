import { expect, vi } from 'vitest';

// Observe both React's <img src> attribute writes and new Image().src assignments.
// Native jsdom images remain intact, so fireEvent exercises actual DOM event handlers.
export function recordImages() {
  const requests: { image: HTMLImageElement; url: string }[] = [];
  const mounting = new WeakMap<HTMLImageElement, string>();
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
  const setAttribute = Element.prototype.setAttribute;
  vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (
    this: HTMLImageElement,
    url: string,
  ) {
    // React sets src during detached initialization, then repeats it in commitMount.
    // Treat that one mount pair as one request, without hiding later retries.
    if (mounting.get(this) !== url || !this.isConnected) requests.push({ image: this, url });
    mounting.delete(this);
    src.set!.call(this, url);
  });
  vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (
    this: Element,
    name: string,
    value: string,
  ) {
    if (this instanceof HTMLImageElement && name.toLowerCase() === 'src') {
      requests.push({ image: this, url: value });
      if (!this.isConnected) mounting.set(this, value);
    }
    setAttribute.call(this, name, value);
  });
  return {
    requests,
    forUrl: (url: string) => requests.filter((request) => request.url === url),
    loader(url: string): HTMLImageElement {
      const matches = requests.filter((request) => request.url === url);
      expect(matches, `one initial image request for ${url}`).toHaveLength(1);
      return matches[0]!.image;
    },
  };
}

export function displayedImage(container: HTMLElement): HTMLImageElement {
  const images = [...container.querySelectorAll('img')].filter((image) => {
    let element: HTMLElement | null = image;
    while (element && element !== container) {
      const style = getComputedStyle(element);
      if (
        element.hidden ||
        element.classList.contains('hidden') ||
        element.classList.contains('invisible') ||
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0'
      )
        return false;
      element = element.parentElement;
    }
    return true;
  });
  expect(images, 'exactly one displayed icon, including while loading').toHaveLength(1);
  return images[0]!;
}

export function expectBuiltin(container: HTMLElement, file: string): HTMLImageElement {
  const image = displayedImage(container);
  expect(image.getAttribute('src')).toMatch(new RegExp(`/assets/${file}\\.svg(?:\\?.*)?$`));
  expect(image.getAttribute('alt')).toBe('');
  expect(image.getAttribute('aria-hidden')).toBe('true');
  return image;
}
