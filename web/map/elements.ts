// The map's DOM elements, shared by the map modules.

import { $ } from "../dom";

export const stage = $("#map-stage");
export const inner = $("#map-inner");
export const mapImg = $<HTMLImageElement>("#map-img");
export const selCanvas = $<HTMLCanvasElement>("#map-sel");
export const drawSvg = $<SVGSVGElement>("#map-draw");
export const shapesSvg = $<SVGSVGElement>("#map-shapes");
