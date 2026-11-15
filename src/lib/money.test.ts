import { describe, expect, it } from "vitest";
import { feeCurrency, formatMoney, parseFee, sumByCurrency } from "./money";

describe("parseFee", () => {
  it("reads US and European grouping", () => {
    expect(parseFee("$2,500.00")).toBe(2500);
    expect(parseFee("€150.000,00")).toBe(150000);
    expect(parseFee("$4,000 a month")).toBe(4000);
    expect(parseFee("12,50 EUR")).toBe(12.5);
    expect(parseFee("$8,000")).toBe(8000);
    expect(parseFee("$8,000.50")).toBe(8000.5);
    expect(parseFee("8.000,50 €")).toBe(8000.5);
    expect(parseFee("₹1,00,000")).toBe(100000);
  });
  it("reads spaces and apostrophes between thousands", () => {
    expect(parseFee("5 000 €")).toBe(5000);
    expect(parseFee("SEK 50 000")).toBe(50000);
    expect(parseFee("120 000 RSD")).toBe(120000);
    expect(parseFee("2 000 000 RSD")).toBe(2_000_000);
    expect(parseFee("CHF 12'500")).toBe(12500);
    expect(parseFee("CHF 12’500.50")).toBe(12500.5);
    expect(parseFee("5 000 €")).toBe(5000);
    expect(parseFee("1 234,56 €")).toBe(1234.56);
  });
  it("ends the number at a gap that isn't a group of three", () => {
    expect(parseFee("$5,000 - $7,000")).toBe(5000);
    expect(parseFee("€5 000 - 7 000")).toBe(5000);
    expect(parseFee("1234 567")).toBe(1234);
    expect(parseFee("$8,000.")).toBe(8000);
    expect(parseFee("approx. $5,000")).toBe(5000);
  });
  it("scales thousands and millions", () => {
    expect(parseFee("$8.5k")).toBe(8500);
    expect(parseFee("$1.2M a year")).toBe(1_200_000);
    expect(parseFee("2 million")).toBe(2_000_000);
    expect(parseFee("$40K")).toBe(40000);
    expect(parseFee("$5k/month")).toBe(5000);
    expect(parseFee("$1.2M")).toBe(1_200_000);
  });
  it("reads a decimal comma before a scale", () => {
    expect(parseFee("€2,5k")).toBe(2500);
    expect(parseFee("$1,5M")).toBe(1_500_000);
    expect(parseFee("1,25 million")).toBe(1_250_000);
    expect(parseFee("$1,500k")).toBe(1_500_000);
  });
  it("reads a leading decimal point", () => {
    expect(parseFee("$.5M")).toBe(500_000);
    expect(parseFee("$.75/min")).toBe(0.75);
    expect(parseFee(".5k")).toBe(500);
  });
  it("doesn't mistake a word for a scale", () => {
    expect(parseFee("$3,000 monthly")).toBe(3000);
    expect(parseFee("$500 min")).toBe(500);
    expect(parseFee("TBD")).toBe(0);
  });
});

describe("feeCurrency", () => {
  it("reads the sign or the code", () => {
    expect(feeCurrency("$8,500")).toBe("USD");
    expect(feeCurrency("CA$8,500")).toBe("CAD");
    expect(feeCurrency("€2.500")).toBe("EUR");
    expect(feeCurrency("£900 a month")).toBe("GBP");
    expect(feeCurrency("2500 eur")).toBe("EUR");
    expect(feeCurrency("8,500")).toBeNull();
  });
  it("tells other dollars from US dollars", () => {
    expect(feeCurrency("R$ 5.000")).toBe("BRL");
    expect(feeCurrency("S$5,000")).toBe("SGD");
    expect(feeCurrency("MX$5,000")).toBe("MXN");
    expect(feeCurrency("HK$50,000")).toBe("HKD");
    expect(feeCurrency("NT$30,000")).toBe("TWD");
    expect(feeCurrency("A$900")).toBe("AUD");
    expect(feeCurrency("NZ$1,000")).toBe("NZD");
    expect(feeCurrency("US$5,000")).toBe("USD");
    expect(feeCurrency("Fee: $5,000")).toBe("USD");
    expect(feeCurrency("HKD 5,000")).toBe("HKD");
  });
  it("doesn't guess a dollar it can't name", () => {
    expect(feeCurrency("J$50,000")).toBeNull();
  });
  it("takes a word or lower case stuck to the sign as a plain dollar", () => {
    expect(feeCurrency("Fee$5,000")).toBe("USD");
    expect(feeCurrency("Monthly$500")).toBe("USD");
    expect(feeCurrency("a$900")).toBe("USD");
  });
});

describe("sumByCurrency", () => {
  it("keeps each currency apart", () => {
    expect(sumByCurrency(["$8,500", "$1,500", "€2.500,00"])).toEqual([
      { currency: "USD", total: 10000, count: 2 },
      { currency: "EUR", total: 2500, count: 1 },
    ]);
  });
  it("never adds another dollar to US dollars", () => {
    expect(sumByCurrency(["$8,000", "R$ 5.000"])).toEqual([
      { currency: "USD", total: 8000, count: 1 },
      { currency: "BRL", total: 5000, count: 1 },
    ]);
    expect(sumByCurrency(["$8,000", "$1,000", "J$50,000"])).toEqual([
      { currency: "USD", total: 9000, count: 2 },
      { currency: "J$", total: 50000, count: 1 },
    ]);
  });
  it("counts a fee with no currency in the one most fees use", () => {
    expect(sumByCurrency(["€1.000", "€2.000", "500", "$300"])).toEqual([
      { currency: "EUR", total: 3500, count: 3 },
      { currency: "USD", total: 300, count: 1 },
    ]);
  });
  it("takes plain numbers as US dollars when no fee says otherwise", () => {
    expect(sumByCurrency(["8,500", "1,500"])).toEqual([{ currency: "USD", total: 10000, count: 2 }]);
  });
  it("still counts a fee it can't read, at zero", () => {
    expect(sumByCurrency(["$2,000", "TBD"])).toEqual([{ currency: "USD", total: 2000, count: 2 }]);
    expect(sumByCurrency([])).toEqual([]);
  });
});

describe("formatMoney", () => {
  it("writes whole amounts with the right sign", () => {
    expect(formatMoney(8500, "USD")).toBe("$8,500");
    expect(formatMoney(2500.4, "EUR")).toBe("€2,500");
    expect(formatMoney(900, "GBP")).toBe("£900");
    expect(formatMoney(0, "USD")).toBe("$0");
  });
  it("shortens big amounts only when asked", () => {
    expect(formatMoney(12345, "USD", { short: true })).toBe("$12.3K");
    expect(formatMoney(12000, "USD", { short: true })).toBe("$12K");
    expect(formatMoney(1_250_000, "USD", { short: true })).toBe("$1.3M");
    expect(formatMoney(9500, "USD", { short: true })).toBe("$9,500");
    expect(formatMoney(12345, "USD")).toBe("$12,345");
  });
  it("doesn't break on a code it doesn't know", () => {
    expect(formatMoney(1200, "dollars")).toBe("dollars 1,200");
    expect(formatMoney(50000, "J$")).toBe("J$ 50,000");
    expect(formatMoney(50000, "J$", { short: true })).toBe("J$ 50K");
  });
});
