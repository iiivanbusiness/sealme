import { describe, expect, it } from "vitest";
import { activeNavHref, navGroupsFor } from "./nav-config";

const hrefsOf = (groups: ReturnType<typeof navGroupsFor>) => groups.flatMap((g) => g.items.map((i) => i.href));

describe("Team in the menu", () => {
  it("shows to a manager once the workspace has two or more people", () => {
    expect(hrefsOf(navGroupsFor({ admin: false, manager: true, members: 2 }))).toContain("/team");
    expect(hrefsOf(navGroupsFor({ admin: false, manager: true, members: 5, phone: true }))).toContain("/team");
  });

  it("is left out for someone working alone", () => {
    expect(hrefsOf(navGroupsFor({ admin: false, manager: true, members: 1 }))).not.toContain("/team");
    expect(hrefsOf(navGroupsFor({ admin: false, manager: true, members: 1, phone: true }))).not.toContain("/team");
    expect(hrefsOf(navGroupsFor({ admin: false, manager: true }))).not.toContain("/team");
  });

  it("is never there for a rep", () => {
    expect(hrefsOf(navGroupsFor({ admin: false, manager: false, members: 8 }))).not.toContain("/team");
  });

  it("keeps Settings, where people are invited, either way", () => {
    expect(hrefsOf(navGroupsFor({ admin: false, manager: true, members: 1 }))).toContain("/settings");
  });
});

describe("Which menu item is lit up", () => {
  const hrefs = hrefsOf(navGroupsFor({ admin: false, manager: true, members: 3 }));

  it("lights up the page's own item, and its pages under it", () => {
    expect(activeNavHref("/leads", hrefs)).toBe("/leads");
    expect(activeNavHref("/leads/abc123", hrefs)).toBe("/leads");
    expect(activeNavHref("/templates/abc/edit", hrefs)).toBe("/templates");
    expect(activeNavHref("/team", hrefs)).toBe("/team");
  });

  it("lights up Leads on a proposal or contract, and the trash", () => {
    expect(activeNavHref("/deals/abc123", hrefs)).toBe("/leads");
    expect(activeNavHref("/deals/abc123/contract", hrefs)).toBe("/leads");
    expect(activeNavHref("/deals/abc123/send", hrefs)).toBe("/leads");
    expect(activeNavHref("/deals/trash", hrefs)).toBe("/leads");
  });

  it("lights up the Dashboard on Start a call", () => {
    expect(activeNavHref("/deals/new", hrefs)).toBe("/dashboard");
  });

  it("doesn't mistake a look-alike path, and lights nothing for a page with no item", () => {
    expect(activeNavHref("/dealsx", hrefs)).toBeUndefined();
    expect(activeNavHref("/leadsx", hrefs)).toBeUndefined();
    expect(activeNavHref("/calls", hrefs)).toBeUndefined();
  });

  it("lights nothing when the item it belongs under isn't in the menu", () => {
    expect(activeNavHref("/deals/abc123", ["/dashboard", "/settings"])).toBeUndefined();
  });
});
