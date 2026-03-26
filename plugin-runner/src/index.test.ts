import { describe, it, expect } from "vitest";
import { isGitUrlSchemeAllowed } from "./plugin-lifecycle.js";

describe("isGitUrlSchemeAllowed", () => {
  it("allows https:// URLs", () => {
    expect(isGitUrlSchemeAllowed("https://github.com/user/repo.git")).toBe(true);
  });

  it("allows http:// URLs", () => {
    expect(isGitUrlSchemeAllowed("http://example.com/repo.git")).toBe(true);
  });

  it("allows git:// URLs", () => {
    expect(isGitUrlSchemeAllowed("git://github.com/user/repo.git")).toBe(true);
  });

  it("allows ssh:// URLs", () => {
    expect(isGitUrlSchemeAllowed("ssh://git@github.com/user/repo.git")).toBe(true);
  });

  it("allows git@ SCP-style SSH URLs", () => {
    expect(isGitUrlSchemeAllowed("git@github.com:user/repo.git")).toBe(true);
  });

  it("rejects ext:: URLs (arbitrary command execution)", () => {
    expect(isGitUrlSchemeAllowed("ext::sh -c 'id >/tmp/pwned'")).toBe(false);
  });

  it("rejects file:// URLs", () => {
    expect(isGitUrlSchemeAllowed("file:///etc/passwd")).toBe(false);
  });

  it("rejects bare paths", () => {
    expect(isGitUrlSchemeAllowed("/tmp/repo")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isGitUrlSchemeAllowed("")).toBe(false);
  });

  it("rejects URLs with no scheme", () => {
    expect(isGitUrlSchemeAllowed("github.com/user/repo")).toBe(false);
  });
});
