// Playwright in the packaged test environment cancels all browser downloads, so inspect the Blob
// produced by the app instead of relying on the browser's filesystem download handling.
export async function captureDownload(page, selector) {
  await page.evaluate(() => {
    window.__downloadCapture = null;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      window.__downloadCapture = { blob, filename: null };
      return create(blob);
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && window.__downloadCapture) window.__downloadCapture.filename = this.download;
      return click.call(this);
    };
  });
  await page.click(selector);
  await page.waitForFunction(() => window.__downloadCapture?.filename, undefined, { timeout: 10000 });
  return page.evaluate(async () => {
    const { blob, filename } = window.__downloadCapture;
    return { filename, text: await blob.text(), bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
  });
}
