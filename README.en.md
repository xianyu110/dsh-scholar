# DSH Scholar

[简体中文](README.md) | **English**

DSH Scholar is an AI research workspace for computational research. It keeps research materials, project conversations, code and data, experiment runs, the evidence ledger, and TeX manuscripts in one recoverable project. You can start with a new question or resume work already in progress elsewhere.

![DSH Scholar home page in Chinese](docs/assets/dsh-scholar-home-zh.png)

## Core capabilities

- **Governed research workflow**: human Gates protect critical transitions from Scope, Idea, and Experiment Contract through Evidence, Claim, and Release.
- **Controlled experiments**: the Runner executes frozen experiment plans in local Docker or on a controlled remote machine and records logs, status, and artifacts.
- **Traceable evidence**: manuscript claims can be traced back to controlled Runs, Artifacts, and reviewed Evidence.
- **Integrated workspace**: Chat, Workspace, Terminal, Manuscript, Trajectory, and Settings share the same project context.
- **Recoverable and auditable state**: the Research Kernel stores authoritative state, NextAction, approval history, and artifact references.

## Intended use and boundaries

- DSH Scholar assists researchers; it does not assume responsibility for scientific judgment, approval, authorship, or publication.
- The default mode is `gate-only`. Agents cannot approve Human Gates, fabricate accepted Evidence, or bypass an experiment contract.
- Formal experiments must bind immutable code and data snapshots to a fixed execution environment and run through a controlled Runner.
- Chat messages, ordinary stdout, and Interactive Terminal output do not automatically become formal Evidence.
- The product is designed for computational research such as machine learning, data science, and bioinformatics. It is not intended for clinical decisions, human studies, wet-lab work, or other high-risk research.

## Quick start

See the [development, testing, and deployment guide](docs/test-instance-plan.md) for the complete environment, port, variable, and acceptance matrix. A local setup requires:

- Linux;
- Node.js 24;
- pnpm 11.20.0;
- Docker Engine, required for formal experiments, TeX compilation, and clean-room reproduction.

### 1. Install and build

```bash
pnpm install --frozen-lockfile
pnpm run build
```

### 2. Start the standalone workspace

```bash
bash scripts/start-standalone-ui.sh
```

The default page is <http://127.0.0.1:18610>, and the Research Kernel listens on `127.0.0.1:17413`. On first open, paste the access token from this `0600` file:

```text
~/.dsh-scholar-standalone/research-ui-standalone/standalone-token
```

Use `--no-token` only in an isolated, supervised, loopback-only development environment.

### 3. Start the experiment Runner

You can manage projects and files without a Runner, but experiment Jobs will remain queued. To execute experiments in local Docker, open another terminal:

```bash
export DSH_SCHOLAR_KERNEL_TOKEN="$(< ~/.dsh-scholar-standalone/research-ui-standalone/kernel-token)"
export DSH_SCHOLAR_SERVICE_TOKEN="$(< ~/.dsh-scholar-standalone/research-ui-standalone/service-token)"
node workers/runner-gateway/lib/bin/runner.js \
  --kernel http://127.0.0.1:17413 \
  --mode docker
```

### 4. Install the Agent plugin in DSH

For the complete DSH Scholar integration experience, install and build the latest DSH source with pnpm, then run DSH from that source checkout. From the DSH repository root, run:

```bash
pnpm install
pnpm run build
```

The `@dsh-scholar/*` packages are not published yet, so add the absolute path of this repository as a local plugin in DSH's `web` profile:

```bash
cd /path/to/dsh-source
pnpm dsh plugin --profile web add /absolute/path/to/dsh-scholar
pnpm dsh plugin --profile web why @dsh-scholar/research-plugin
pnpm dsh web
```

Here, `/path/to/dsh-source` is the latest DSH source checkout and `/absolute/path/to/dsh-scholar` is this repository. This keeps the plugin APIs, Web UI, Skills, and configuration surface aligned with the latest DSH source. The standalone workspace does not require DSH, but it does not include the full Agent tools, slash commands, Skills, configuration card, and `dsh Scholar` tab integration.

To update Scholar, run `pnpm run build` in this repository, return to the DSH source checkout, and run `pnpm dsh plugin --profile web add /absolute/path/to/dsh-scholar` again. To uninstall:

```bash
pnpm dsh plugin --profile web remove @dsh-scholar/research-plugin
```

The plugin provides Scholar Agent tools, slash commands, Skills, a configuration card, and the `dsh Scholar` tab. The tab reuses the running standalone workspace.

## Plugin config

After installing the plugin, open **Settings → Plugin config → dsh Scholar** in DSH. Saved changes take effect after the next DSH restart.

![DSH Scholar plugin configuration in the Chinese UI](docs/assets/dsh-scholar-plugin-config-zh.png)

| Setting | Default | Description |
|---|---|---|
| Default governance mode | `gate-only` | Used when a new project does not explicitly specify a mode. `gate-only` preserves human approval Gates; `full-auto` is only suitable for low-risk sandboxes with a configured FixtureProfile. |
| Unattended runs | Off | Does not bypass Human Gates. At a Gate, the project pauses instead of waiting for an interactive answer. |
| Standalone URL | `http://127.0.0.1:18610/` | Target used by the plugin tab and **Open in new page**. Only HTTPS or loopback HTTP is allowed. |
| Open-page shortcut | `Alt+Shift+S` | Can be disabled. It does not trigger while typing or using an IME. |

The Standalone URL cannot contain credentials, query parameters, or fragments, and tokens must not be placed in the URL. **Copy standalone access token** is available only from a local loopback DSH instance and reads the fixed `0600` token file after an explicit user click. The page never displays the token. This action does not copy Kernel, Runner, Provider, or SSH secrets.

See the [DSH host integration specification](docs/dsh-integration.md) for the complete configuration and host constraints.

## Start a research project

There are three ways to begin:

1. **Init**: enter a project name, complete the research Brief through Grill Me in Chat, and create the Scope Gate after confirmation.
2. **Resume**: open an existing project and restore its stage, sessions, files, and tasks.
3. **Upload**: add papers, code, data, or logs and join an existing research stage. Uploaded material first enters isolated Intake and does not automatically become Evidence.

Typical workflow:

```text
Create/import project → Grill Me → Scope Gate → literature survey → Idea Gate
→ Baseline → Experiment Contract → experiment runs → Evidence and Claim
→ TeX writing and review → private export → Release Gate
```

At every stage, Overview and Chat read the authoritative `NextAction` from the Kernel and show the next step, rationale, actor, and blockers.

## Workspace overview

| Area | Purpose |
|---|---|
| Chat | Hold project conversations, answer Grill questions, upload files, and trigger explicit research operations. |
| Workspace | Browse, edit, upload, and manage project files; version/etag prevents silent overwrites. |
| Run / Terminal | Inspect formal Job status and read-only logs, or use a project-bound Interactive Terminal. |
| Evidence / Artifacts | Review claims, metrics, confidence, provenance, and generated outputs. |
| Manuscript | Edit TeX, inspect diagnostics and compilation logs, and preview the latest PDF. |
| Trajectory / Topology | Inspect the research trajectory, subagent parent-child relationships, status, and outputs. |
| Settings | Configure Model Providers, OCR, budgets, Runner Profiles, and execution environments. |

Chat supports natural-language messages and top-level slash commands. Common commands include:

```text
/new  /status  /survey  /ideas  /gates  /contract  /run
/evidence  /claims  /write  /review  /release-bundle  /release
```

See the [usage guide](docs/USAGE_GUIDE.md) for complete interactions, commands, and stage-by-stage instructions.

## Use case: CNN handwritten-digit recognition

The `cnn-mnist-digits` project shows how a model-improvement idea becomes an auditable conclusion.

| Item | Details |
|---|---|
| Research question | Does a two-convolution CNN with per-channel normalization outperform a single-convolution CNN baseline? |
| Dataset and metric | `mnist_subset_v1`; `test_accuracy` |
| Random seeds | `11` / `23` / `47` |
| Result | `test_accuracy = 96.8%`; `+4.4` percentage points over baseline |
| Uncertainty | bootstrap 95% CI for the mean difference `[1.2, 8.6]`; `n=3` |

The Overview page brings the research question, current stage, completion, and next action into a single view.

![CNN handwritten-digit recognition project overview](docs/assets/cnn-mnist-overview.png)

### 1. Advance the project through Chat

Each research project has independent conversations. Researchers can describe a task directly, use commands such as `/status`, `/survey`, and `/run`, and add research materials through attachments, drag-and-drop, or paste.

![Project Chat for the CNN example](docs/assets/cnn-mnist-chat.png)

### 2. Approve the research design

Scope, Idea, and Contract Gates successively lock the scope, proposal, and experiment contract. The researcher still decides the Release Gate.

![Human Gate approvals for the CNN example](docs/assets/cnn-mnist-gates.png)

### 3. Execute controlled comparisons

Baseline and formal configurations run as independent Jobs. In the screenshot, seven of eight runs succeeded and one failed. The failed record remains visible with an explicit retry action.

![Baseline and formal experiment runs for the CNN example](docs/assets/cnn-mnist-runs.png)

### 4. Inspect run data and the remote terminal

Run Terminal provides read-only stdout/stderr, exit status, and recoverable logs for a formal Job. The following view shows baseline `train_loss` and `test_acc` by epoch, plus the final `test_accuracy = 88.3` for random seed `23`.

![Training metrics and run logs for the CNN example](docs/assets/cnn-mnist-run-terminal.png)

Interactive Terminal is a real Web PTY bound to a project or session. It connects to the execution environment for command input, resizing, and session reconnection. It is useful for interactive inspection and debugging, but its output does not automatically become formal Evidence.

![DSH Scholar remote interactive Web terminal](docs/assets/cnn-mnist-web-terminal.png)

### 5. Aggregate evidence

The system binds metrics, effect size, confidence intervals, Runs, and Artifacts to Evidence. After review, this example's Evidence is marked `accepted` and supports the claim that the two-convolution configuration outperforms the baseline.

![Accuracy Evidence and confidence interval for the CNN example](docs/assets/cnn-mnist-evidence.png)

### 6. Write and release

The Manuscript workspace edits `paper.tex` and `main.bib` and compiles the manuscript in a pinned TeX Live environment. After review and packaging, external release still requires approval at the Release Gate.

![TeX Manuscript workspace for the CNN example](docs/assets/cnn-mnist-manuscript.png)

## Development and reference

Common validation commands:

```bash
pnpm run verify:docs
pnpm test
bash scripts/ci-gate.sh
```

- [Usage guide](docs/USAGE_GUIDE.md): complete interaction flow and troubleshooting.
- [Runtime guide](docs/test-instance-plan.md): environment, ports, environment variables, Runner, and test commands.
- [DSH host integration](docs/dsh-integration.md): plugin shape, configuration, tools, commands, and installation.
- [Security and research-integrity baseline](docs/security-baseline.md): Gates, secrets, Runner, Evidence, and web security.
- [Acceptance and test specification](docs/acceptance-tests.md): functional, security, and regression scenarios.

## License

This project is licensed under the [MIT License](LICENSE).
