import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = mkdtempSync(join(tmpdir(), "playphoto-live-deploy-"));
const fakeBin = join(root, "bin");
const deployDirectory = join(root, "deploy");
const rollbackDirectory = join(deployDirectory, ".rollback");
mkdirSync(fakeBin, { recursive: true });
mkdirSync(rollbackDirectory, { recursive: true });

const oldImage = "registry.example/bot@sha256:" + "a".repeat(64);
const newImage = "registry.example/bot@sha256:" + "b".repeat(64);

const executable = (name, source) => {
    const path = join(fakeBin, name);
    writeFileSync(path, source, { mode: 0o755 });
};

executable(
    "aws",
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"secretsmanager get-secret-value"* ]]; then
  printf '%s\\n' '{"dockerEnv":"BOT_TOKEN=dummy","googleServiceAccountJson":"{}","databaseUrl":"postgresql://db","businessApiUrl":"https://api.example","businessApiToken":"12345678901234567890123456789012","redisUrl":"redis://redis:6379"}'
elif [[ "$*" == *"ecr get-login-password"* ]]; then
  printf 'password'
else
  exit 1
fi
`
);

executable("sleep", "#!/usr/bin/env bash\nexit 0\n");
executable("flock", "#!/usr/bin/env bash\nexit 0\n");
executable(
    "docker",
    `#!/usr/bin/env bash
set -euo pipefail
args="$*"
case "$args" in
  *"login --username AWS"*|*"logout "*) exit 0 ;;
  *"ps --quiet bot"*) echo bot-container ;;
  *"{{json .Config.Cmd}}"*) echo '["npm","run","start:live"]' ;;
  *".State.Health"*) echo healthy ;;
  *".RestartCount"*) echo 0 ;;
  *"up -d --remove-orphans"*)
    if [[ "\${FAIL_DEPLOY:-false}" == "true" && ! -e "\${DEPLOY_TEST_STATE}/failed-once" ]]; then
      touch "\${DEPLOY_TEST_STATE}/failed-once"
      exit 1
    fi
    ;;
esac
exit 0
`
);

const writeRuntime = () => {
    writeFileSync(join(deployDirectory, ".env"), "ORIGINAL_ENV=true\n", { mode: 0o600 });
    writeFileSync(join(deployDirectory, "google-service-account.json"), "{}\n", { mode: 0o600 });
    writeFileSync(join(deployDirectory, "compose.aws.yaml"), "services: {}\n");
    writeFileSync(join(deployDirectory, "compose.aws.live.yaml"), "services: {}\n");
    writeFileSync(
        join(deployDirectory, "release.env"),
        `BOT_IMAGE=${newImage}\nBOT_RUNTIME_MODE=live\nAWS_SCHEDULE_SHADOW_READ_ENABLED=false\nAWS_SCHEDULE_CANONICAL_READ_ENABLED=false\n`
    );
    writeFileSync(join(rollbackDirectory, ".env"), "ROLLBACK_ENV=true\n", { mode: 0o600 });
    writeFileSync(join(rollbackDirectory, "google-service-account.json"), "{}\n", { mode: 0o600 });
    writeFileSync(join(rollbackDirectory, "compose.aws.yaml"), "services: {}\n");
    writeFileSync(join(rollbackDirectory, "compose.aws.live.yaml"), "services: {}\n");
    writeFileSync(join(rollbackDirectory, "runtime.env"), `BOT_IMAGE=${oldImage}\nBOT_RUNTIME_MODE=live\n`, {
        mode: 0o600
    });
    writeFileSync(
        join(rollbackDirectory, "installed-release.env"),
        `BOT_IMAGE=${oldImage}\nBOT_RUNTIME_MODE=standby\nGIT_SHA=previous\n`,
        { mode: 0o600 }
    );
};

const run = (failDeploy) => {
    writeRuntime();
    rmSync(join(root, "failed-once"), { force: true });
    return spawnSync("bash", ["scripts/aws/deploy-production-bot.sh"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH}`,
            BOT_IMAGE: newImage,
            BOT_RUNTIME_MODE: "live",
            RUNTIME_SECRET_ID: "test/runtime",
            AWS_REGION: "eu-north-1",
            AWS_SCHEDULE_SHADOW_READ_ENABLED: "false",
            AWS_SCHEDULE_CANONICAL_READ_ENABLED: "false",
            DEPLOY_DIRECTORY: deployDirectory,
            DEPLOY_TEST_STATE: root,
            FAIL_DEPLOY: failDeploy ? "true" : "false"
        }
    });
};

try {
    const success = run(false);
    if (success.status !== 0) throw new Error(`Live deploy simulation failed: ${success.stderr}`);
    const deployedEnv = readFileSync(join(deployDirectory, ".env"), "utf8");
    if (!deployedEnv.includes("AWS_SCHEDULE_SHADOW_READ_ENABLED=false")) {
        throw new Error("Live deploy did not force the reviewed shadow flag");
    }
    if (!deployedEnv.includes("AWS_SCHEDULE_CANONICAL_READ_ENABLED=false")) {
        throw new Error("Live deploy did not force the reviewed canonical flag");
    }

    const failure = run(true);
    if (failure.status === 0) throw new Error("Forced deployment failure unexpectedly succeeded");
    const restoredRelease = readFileSync(join(deployDirectory, "release.env"), "utf8");
    const restoredEnv = readFileSync(join(deployDirectory, ".env"), "utf8");
    if (!restoredRelease.includes(`BOT_IMAGE=${oldImage}`) || !restoredEnv.includes("ROLLBACK_ENV=true")) {
        throw new Error("Forced deployment failure did not restore the immutable rollback runtime");
    }

    console.log("Production bot live deploy and local rollback simulations passed.");
} finally {
    rmSync(root, { recursive: true, force: true });
}
