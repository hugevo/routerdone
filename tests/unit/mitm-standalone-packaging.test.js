import { describe, expect, it } from "vitest";
import fs from "fs";

const dockerfile = fs.readFileSync("Dockerfile", "utf8");
const mitmServer = fs.readFileSync("src/mitm/server.js", "utf8");

describe("MITM standalone packaging", () => {
  it("copies shared MITM constants into the Docker runner", () => {
    expect(dockerfile).toContain("COPY --from=builder /app/src/mitm ./src/mitm");
    expect(dockerfile).toContain("COPY --from=builder /app/src/shared/constants ./src/shared/constants");
  });

  it("filters lsof output to numeric PIDs before killing port 443 owners", () => {
    expect(mitmServer).toContain("Number.isInteger(Number(p))");
    expect(mitmServer).toContain("Number(p) > 0");
  });
});