import { download } from "@/lib/backup";
import { canvasSnapshot } from "@/components/react/ui/canvasSnapshot";

const NS = "http://www.w3.org/2000/svg";
const STYLE = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "paint-order",
  "visibility",
  "display",
  "filter",
] as const;

function element(name: string, attributes: Record<string, string | number> = {}) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

function freezeSvg(source: SVGElement): SVGElement {
  const clone = source.cloneNode(true) as SVGElement;
  const originals = [source, ...source.querySelectorAll<SVGElement>("*")];
  const copies = [clone, ...clone.querySelectorAll<SVGElement>("*")];
  originals.forEach((original, index) => {
    const copy = copies[index];
    const style = getComputedStyle(original);
    copy.removeAttribute("class");
    copy.removeAttribute("style");
    for (const property of STYLE)
      copy.style.setProperty(property, style.getPropertyValue(property));
    // Computed fragment URLs include the page address; the exported document has its own address.
    for (const attribute of [...copy.attributes]) {
      if (attribute.value.includes("url(")) {
        copy.setAttribute(
          attribute.name,
          attribute.value.replace(/url\(["']?[^)#]*#([^)'" ]+)["']?\)/g, "url(#$1)"),
        );
      }
    }
    if (style.pointerEvents === "stroke" && Number(style.opacity) === 0) copy.remove();
  });
  return clone;
}

let fonts: Promise<string> | undefined;
function embeddedFonts(): Promise<string> {
  fonts ??= (async () => {
    const faces: string[] = [];
    for (const sheet of [...document.styleSheets]) {
      const visit = async (rules: CSSRuleList) => {
        for (const rule of [...rules]) {
          if (rule instanceof CSSFontFaceRule) {
            let css = rule.cssText;
            for (const match of [...css.matchAll(/url\(["']?([^)'" ]+)["']?\)/g)]) {
              const response = await fetch(new URL(match[1], sheet.href ?? document.baseURI));
              if (!response.ok) throw new Error("Could not load the export font");
              const blob = await response.blob();
              const data = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(blob);
              });
              css = css.replace(match[0], `url("${data}")`);
            }
            faces.push(css);
          } else if ("cssRules" in rule) {
            await visit((rule as CSSGroupingRule).cssRules);
          }
        }
      };
      await visit(sheet.cssRules);
    }
    return faces.join("\n");
  })();
  return fonts;
}

/** Freeze the drawn face, including the canvas year marks and the HTML readout, without exporting app chrome. */
export async function faceSvg(stage: HTMLElement): Promise<string> {
  await document.fonts.ready;
  const source = stage.querySelector<SVGSVGElement>(":scope > svg");
  if (!source) throw new Error("No face to export");
  const matrix = source.getScreenCTM();
  if (!matrix || matrix.a <= 0) throw new Error("The face is not visible");
  const inverse = matrix.inverse();
  const view = source.viewBox.baseVal;
  const root = element("svg", {
    xmlns: NS,
    viewBox: `${view.x} ${view.y} ${view.width} ${view.height}`,
    width: 1600,
    height: 1600,
  });
  const style = element("style");
  style.textContent = await embeddedFonts();
  root.append(style);
  root.append(
    element("rect", {
      x: view.x,
      y: view.y,
      width: view.width,
      height: view.height,
      fill: getComputedStyle(document.documentElement).getPropertyValue("--void").trim(),
    }),
  );
  const frozen = freezeSvg(source);
  for (const node of [...frozen.childNodes]) root.append(node);
  for (const canvas of stage.querySelectorAll<HTMLCanvasElement>(":scope > canvas")) {
    const box = canvas.getBoundingClientRect();
    const point = new DOMPoint(box.x, box.y).matrixTransform(inverse);
    const snapshot = canvasSnapshot(canvas);
    if (snapshot) {
      snapshot.setAttribute(
        "transform",
        `translate(${point.x} ${point.y}) scale(${1 / matrix.a} ${1 / matrix.d})`,
      );
      root.append(snapshot);
    } else {
      root.append(
        element("image", {
          x: point.x,
          y: point.y,
          width: box.width / matrix.a,
          height: box.height / matrix.d,
          href: canvas.toDataURL("image/png"),
        }),
      );
    }
  }
  const readout = stage.querySelector<HTMLElement>("[data-export-readout]");
  if (readout) {
    let measure: CanvasRenderingContext2D | null | undefined;
    const walker = document.createTreeWalker(readout, NodeFilter.SHOW_TEXT);
    let textNode: Node | null;
    while ((textNode = walker.nextNode())) {
      const parent = textNode.parentElement;
      if (!parent || parent.closest("svg, .sr-only") || !textNode.textContent?.trim()) continue;
      const css = getComputedStyle(parent);
      if (css.display === "none" || css.visibility === "hidden" || Number(css.opacity) === 0)
        continue;
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const lines: { value: string; box: DOMRect }[] = [];
      if (range.getClientRects().length <= 1) {
        lines.push({ value: textNode.textContent, box: range.getBoundingClientRect() });
        const parentBox = parent.getBoundingClientRect();
        if (css.textOverflow === "ellipsis" && lines[0].box.right > parentBox.right) {
          measure ??= document.createElement("canvas").getContext("2d");
          if (measure) {
            measure.font = css.font;
            const value =
              css.textTransform === "uppercase" ? lines[0].value.toUpperCase() : lines[0].value;
            const glyphs = [
              ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value),
            ].map((part) => part.segment);
            const available = parentBox.right - lines[0].box.x;
            const spacing = css.letterSpacing === "normal" ? 0 : parseFloat(css.letterSpacing);
            let visible = glyphs.join("");
            while (
              glyphs.length &&
              measure.measureText(`${visible}…`).width + spacing * (glyphs.length + 1) > available
            ) {
              glyphs.pop();
              visible = glyphs.join("");
            }
            lines[0].value = `${visible}…`;
          }
        }
      } else {
        for (let i = 0; i < textNode.textContent.length; i++) {
          range.setStart(textNode, i);
          range.setEnd(textNode, i + 1);
          const box = range.getBoundingClientRect();
          const previous = lines.at(-1);
          if (previous && Math.abs(previous.box.y - box.y) < 1) {
            previous.value += textNode.textContent[i];
          } else {
            lines.push({ value: textNode.textContent[i], box });
          }
        }
      }
      for (const { value, box } of lines) {
        if (!box.width || !box.height) continue;
        const point = new DOMPoint(box.x, box.y + box.height / 2).matrixTransform(inverse);
        const text = element("text", {
          x: point.x,
          y: point.y,
          fill: css.color,
          "dominant-baseline": "central",
          "font-family": css.fontFamily,
          "font-size": parseFloat(css.fontSize) / matrix.a,
          "font-weight": css.fontWeight,
          "font-style": css.fontStyle,
          "letter-spacing":
            css.letterSpacing === "normal" ? 0 : parseFloat(css.letterSpacing) / matrix.a,
          "text-decoration": css.textDecorationLine,
        });
        text.textContent = css.textTransform === "uppercase" ? value.toUpperCase() : value;
        for (
          let ancestor: HTMLElement | null = parent;
          ancestor && ancestor !== stage;
          ancestor = ancestor.parentElement
        ) {
          if (getComputedStyle(ancestor).overflowX !== "hidden") continue;
          const bounds = ancestor.getBoundingClientRect();
          const corner = new DOMPoint(bounds.x, bounds.y).matrixTransform(inverse);
          const id = `export-clip-${crypto.randomUUID()}`;
          const clip = element("clipPath", { id });
          clip.append(
            element("rect", {
              x: corner.x,
              y: corner.y,
              width: bounds.width / matrix.a,
              height: bounds.height / matrix.d,
            }),
          );
          root.append(clip);
          text.setAttribute("clip-path", `url(#${id})`);
          break;
        }
        root.append(text);
      }
    }
    for (const icon of readout.querySelectorAll<SVGSVGElement>("svg")) {
      const box = icon.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const point = new DOMPoint(box.x, box.y).matrixTransform(inverse);
      const copy = freezeSvg(icon);
      copy.setAttribute("x", String(point.x));
      copy.setAttribute("y", String(point.y));
      copy.setAttribute("width", String(box.width / matrix.a));
      copy.setAttribute("height", String(box.height / matrix.d));
      root.append(copy);
    }
  }
  return new XMLSerializer().serializeToString(root);
}

export async function saveFace(format: "svg" | "png"): Promise<boolean> {
  const stage = document.querySelector<HTMLElement>("[data-export-face]");
  if (!stage) throw new Error("Open the day or year view to save a face");
  const svg = await faceSvg(stage);
  const name = `circal-${stage.dataset.exportFace}-${stage.dataset.exportName}`;
  if (format === "svg") return download(`${name}.svg`, "image/svg+xml", svg);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1600;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not draw the export");
    context.drawImage(image, 0, 0, 1600, 1600);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Could not encode the export"))),
        "image/png",
      ),
    );
    return download(`${name}.png`, "image/png", png);
  } finally {
    URL.revokeObjectURL(url);
  }
}
