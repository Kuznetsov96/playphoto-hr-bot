import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = {
    workflow: ".github/workflows/deploy-aws-production.yml",
    beforeInstall: "deploy/aws/hooks/before-install.sh",
    afterInstall: "deploy/aws/hooks/after-install.sh",
    start: "deploy/aws/hooks/start.sh",
    validate: "deploy/aws/hooks/validate.sh",
    deploy: "scripts/aws/deploy-production-bot.sh",
    mode: "scripts/aws/set-production-mode.sh"
};

const content = Object.fromEntries(Object.entries(files).map(([name, path]) => [name, readFileSync(path, "utf8")]));

const requirements = [
    ["workflow deploys live mode", content.workflow, "printf 'BOT_RUNTIME_MODE=%q\\n' live"],
    ["workflow marks a live-safe revision", content.workflow, "LIVE_SAFE_ROLLBACK_VERSION"],
    ["workflow checks the previous immutable artifact", content.workflow, "previous-bot-revision.zip"],
    ["workflow limits disabled CodeDeploy rollback to bootstrap", content.workflow, "LIVE_SAFE_BASELINE"],
    [
        "workflow keeps shadow telemetry off during bootstrap",
        content.workflow,
        "Bootstrap live-safe deployment requires"
    ],
    ["before-install detects the real container command", content.beforeInstall, ".Config.Cmd"],
    ["before-install verifies the running image", content.beforeInstall, "expected_image_id"],
    ["before-install captures a rollback runtime", content.beforeInstall, "rollback_mode"],
    ["deploy refuses live activation from standby", content.deploy, "existing AWS bot is not already live"],
    ["deploy restores the captured runtime", content.deploy, "restore_rollback_runtime"],
    ["deploy validates stable health", content.deploy, "wait_for_stable_container"],
    ["deploy sets the reviewed shadow flag", content.deploy, "set_env AWS_SCHEDULE_SHADOW_READ_ENABLED"],
    ["deploy sets the reviewed canonical flag", content.deploy, "set_env AWS_SCHEDULE_CANONICAL_READ_ENABLED"],
    ["deploy sets the reviewed replacements shadow flag", content.deploy, "set_env AWS_REPLACEMENTS_SHADOW_ENABLED"],
    [
        "deploy sets the reviewed replacements canonical flag",
        content.deploy,
        "set_env AWS_REPLACEMENTS_CANONICAL_ENABLED"
    ],
    [
        "deploy sets the reviewed reminders canonical read flag",
        content.deploy,
        "set_env AWS_REMINDERS_CANONICAL_READ_ENABLED"
    ],
    [
        "deploy sets the reviewed preferences canonical write flag",
        content.deploy,
        "set_env AWS_PREFERENCES_CANONICAL_WRITE_ENABLED"
    ],
    [
        "deploy sets the reviewed parcels canonical read flag",
        content.deploy,
        "set_env AWS_PARCELS_CANONICAL_READ_ENABLED"
    ],
    ["validate checks live command", content.validate, 'expected_command="start:live"'],
    ["validate checks the shadow flag", content.validate, "actual_shadow_flag"],
    ["validate checks the canonical flag", content.validate, "actual_canonical_flag"],
    ["validate invokes rollback on failure", content.validate, "deploy-production-bot.sh rollback"]
];

for (const [description, value, expected] of requirements) {
    if (!value.includes(expected)) {
        throw new Error(`Production deploy contract failed: ${description}`);
    }
}

// Every dispatch input is written straight into the running bot, so a deploy always sets
// all of them rather than leaving the current values alone. Defaulting the form to `false`
// therefore made "Run workflow" without touching the switches a silent rollback of every
// enabled feature. The defaults must stay `true` to match what production runs; a flag is
// disabled by deliberately unticking it, never by accepting the form as it opens.
const workflowInputDefaults = [
    ...content.workflow.matchAll(/^ {6}([a-z0-9_]+_enabled):\n(?: {8}.*\n)*? {8}default: (true|false)$/gmu)
];
if (workflowInputDefaults.length === 0) {
    throw new Error("Production deploy contract failed: no *_enabled workflow inputs found");
}
for (const [, input, value] of workflowInputDefaults) {
    if (value !== "true") {
        throw new Error(
            `Production deploy contract failed: workflow input ${input} defaults to ${value}; ` +
            "it must default to true so a routine deploy cannot silently disable a live feature"
        );
    }
}

// A boolean flag reaches the running bot only if it is declared in every stage
// of the chain. Miss one and the deploy still succeeds, the summary still
// prints `true`, and the bot silently starts with the flag off — which is what
// happened to AWS_REPLACEMENT_AUTO_CONFIRM_ENABLED on its first production
// deploy. The list is derived from the workflow itself, so a newly added flag
// is covered here without touching this file.
const flags = [...content.workflow.matchAll(/printf '(AWS_[A-Z0-9_]+_ENABLED)=%q\\n'/gu)].map(
    match => match[1]
);
if (flags.length === 0) {
    throw new Error("Production deploy contract failed: no AWS_*_ENABLED flags found in the workflow");
}
for (const flag of flags) {
    const stages = [
        ["exported by the start hook", content.start, flag],
        ["defaulted in the deploy script", content.deploy, `${flag}="\${${flag}:-false}"`],
        ["validated in the deploy script", content.deploy, `echo "${flag} must be true or false."`],
        ["written to the container env", content.deploy, `set_env ${flag} "$${flag}"`]
    ];
    for (const [stage, value, expected] of stages) {
        if (!value.includes(expected)) {
            throw new Error(`Production deploy contract failed: ${flag} is not ${stage}`);
        }
    }
}

const syntax = spawnSync(
    "bash",
    ["-n", files.beforeInstall, files.afterInstall, files.start, files.validate, files.deploy, files.mode],
    { encoding: "utf8" }
);
if (syntax.status !== 0) {
    process.stderr.write(syntax.stderr);
    throw new Error("Production deploy shell syntax validation failed");
}

console.log("Production bot live-deploy contract is valid.");
