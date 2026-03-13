import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir } from "../../utils.js";

export function readJsonl<T>(filePath: string): T[] {
    try {
        const raw = fs.readFileSync(filePath, "utf-8").trim();
        if (!raw) return [];
        return raw
            .split(/\r?\n/)
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line) as T);
    } catch {
        return [];
    }
}

export function writeJsonl<T>(filePath: string, records: T[]): void {
    ensureDir(path.dirname(filePath));
    const content = records.map((record) => JSON.stringify(record)).join("\n");
    fs.writeFileSync(filePath, content ? content + "\n" : "", "utf-8");
}
