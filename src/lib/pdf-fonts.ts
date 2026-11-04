import path from "node:path";
import { Font } from "@react-pdf/renderer";

// react-pdf's built-in Helvetica only has the WinAnsi characters, so
// "Petrović" came out as "Petrovi". Liberation Sans (SIL Open Font License,
// see fonts/LICENSE-LiberationSans.txt) has the same metrics as Helvetica
// and covers Latin Extended-A. The files are read from disk at render time;
// next.config.ts makes sure they ship with every server function.
export const PDF_FONT = "LiberationSans";

const dir = path.join(process.cwd(), "src/lib/fonts");

// Registering twice (dev reloads) would only stack duplicate sources.
if (!Font.getRegisteredFonts()[PDF_FONT]) {
  Font.register({
    family: PDF_FONT,
    fonts: [
      { src: path.join(dir, "LiberationSans-Regular.ttf") },
      { src: path.join(dir, "LiberationSans-Bold.ttf"), fontWeight: 700 },
      { src: path.join(dir, "LiberationSans-Italic.ttf"), fontStyle: "italic" },
    ],
  });
}
