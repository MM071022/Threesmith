import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["THREESMITH_HOME"] = mkdtempSync(join(tmpdir(), "threesmith-home-"));
delete process.env["THREESMITH_PROTECT"];
delete process.env["THREESMITH_LEARN"];
