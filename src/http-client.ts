import { spawnSync } from "node:child_process";

interface PostJsonOptions {
    url: string;
    headers?: Record<string, string>;
    body: unknown;
    timeoutMs?: number;
}

function readFetchResponseText(payload: any): string {
    if (typeof payload?.text === "function") {
        return "";
    }
    return "";
}

function getCurlBinary(): string {
    return process.platform === "win32" ? "curl.exe" : "curl";
}

function isLikelyWsl(): boolean {
    return process.platform === "linux" && Boolean(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME);
}

function postJsonWithCurl(options: PostJsonOptions): any {
    const headerArgs = Object.entries(options.headers || {}).flatMap(([key, value]) => ["-H", `${key}: ${value}`]);
    const body = JSON.stringify(options.body);
    const timeoutSeconds = Math.max(1, Math.ceil((options.timeoutMs || 60000) / 1000));
    const result = spawnSync(
        getCurlBinary(),
        [
            "--silent",
            "--show-error",
            "--request",
            "POST",
            "--max-time",
            String(timeoutSeconds),
            options.url,
            ...headerArgs,
            "--data",
            body,
        ],
        {
            encoding: "utf-8",
            maxBuffer: 8 * 1024 * 1024,
        }
    );

    if (result.status !== 0) {
        throw new Error(result.stderr?.trim() || result.stdout?.trim() || `curl failed with exit ${String(result.status)}`);
    }

    return JSON.parse(result.stdout || "{}");
}

function postJsonWithWindowsPowerShell(options: PostJsonOptions): any {
    const body64 = Buffer.from(JSON.stringify(options.body), "utf-8").toString("base64");
    const url = options.url.replace(/'/g, "''");
    const auth = (options.headers?.Authorization || "").replace(/'/g, "''");
    const timeoutSeconds = Math.max(1, Math.ceil((options.timeoutMs || 60000) / 1000));
    const script = [
        "$ProgressPreference='SilentlyContinue'",
        `$body64='${body64}'`,
        `$url='${url}'`,
        `$auth='${auth}'`,
        `$timeoutSec=${timeoutSeconds}`,
        "$body=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($body64))",
        "$headers=@{}",
        "if($auth){$headers.Authorization=$auth}",
        "$request=[System.Net.WebRequest]::Create($url)",
        "$request.Timeout=$timeoutSec*1000",
        "$response=Invoke-RestMethod -Uri $url -Method POST -Headers $headers -ContentType 'application/json' -Body $body",
        "$response | ConvertTo-Json -Depth 100 -Compress",
    ].join("; ");
    const result = spawnSync(
        "powershell.exe",
        [
            "-NoProfile",
            "-Command",
            "-",
        ],
        {
            encoding: "utf-8",
            maxBuffer: 8 * 1024 * 1024,
            input: script,
        }
    );

    if (result.status !== 0) {
        throw new Error(result.stderr?.trim() || result.stdout?.trim() || `windows powershell fallback failed with exit ${String(result.status)}`);
    }

    return JSON.parse((result.stdout || "").trim() || "{}");
}

export async function postJson(options: PostJsonOptions): Promise<any> {
    if (isLikelyWsl()) {
        try {
            return postJsonWithWindowsPowerShell(options);
        } catch {
            // Fall through to local WSL network path if Windows relay is unavailable.
        }
    }

    try {
        const response = await fetch(options.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                ...(options.headers || {}),
            },
            body: JSON.stringify(options.body),
        });

        if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(`http ${response.status}${text ? `: ${text.slice(0, 240)}` : ""}`);
        }

        return await response.json();
    } catch (error) {
        try {
            return postJsonWithCurl({
                ...options,
                headers: {
                    "Content-Type": "application/json",
                    ...(options.headers || {}),
                },
            });
        } catch (curlError) {
            if (!isLikelyWsl()) {
                throw curlError;
            }
            return postJsonWithWindowsPowerShell({
                ...options,
                headers: {
                    "Content-Type": "application/json",
                    ...(options.headers || {}),
                },
            });
        }
    }
}
