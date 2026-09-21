import { parseFdx } from "../fdx-parser.js";
import { parseFountain } from "./fountain-parser.js";
import { parsePdf } from "./pdf-parser.js";
import { filenameToTitle, ScreenplayParseError } from "./normalized-model.js";

export function supportedFile(file) {
  return /\.(fdx|pdf|fountain|spmd)$/i.test(file?.name || "");
}

export async function parseScreenplay(file) {
  const filename = file?.name || "";
  const fallback = filenameToTitle(filename);
  if (/\.fdx$/i.test(filename)) return parseFdx(await file.text(), fallback);
  if (/\.(fountain|spmd)$/i.test(filename)) return parseFountain(await file.text(), fallback);
  if (/\.pdf$/i.test(filename)) return parsePdf(file, fallback);
  throw new ScreenplayParseError("unsupported", "Choose a Final Draft (.fdx), PDF, or Fountain screenplay.");
}

export { filenameToTitle, ScreenplayParseError };
