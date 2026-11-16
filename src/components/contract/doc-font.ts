import { Source_Serif_4 } from "next/font/google";

// The contract's own typeface: a book serif, so the paper reads as a
// document and not as app UI. Exposed as --font-doc on the paper's wrapper
// (contract.module.css falls back to Georgia while it loads).
export const docFont = Source_Serif_4({
  subsets: ["latin"],
  style: ["normal", "italic"],
  axes: ["opsz"],
  variable: "--font-doc",
  display: "swap",
});
