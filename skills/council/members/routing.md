# Council Member Routing

Smart routing configuration for the `/council` skill. The orchestrator classifies the topic and selects 3-4 relevant members from this table. Users never need to pick members manually.

## Topic Routing

| Topic Keywords | Members | Rationale |
|---------------|---------|-----------|
| architecture, design, system, interface, API | questioner, architect, simplifier, benchmarker | Core design decisions need assumption-challenging, systems thinking, complexity reduction, and performance grounding |
| performance, latency, throughput, scale | benchmarker, questioner, architect, measurer | Evidence-based performance analysis needs benchmarks, skepticism, architectural context, and measurement rigor |
| security, auth, secrets, blast radius | questioner, sentinel, simplifier | Security-first review needs assumption-challenging, breach expertise, and complexity reduction to minimize attack surface |
| API, endpoint, DX, developer, SDK | questioner, simplifier, ergonomist, deployer | Developer experience needs skepticism, minimalism, usability focus, and deployment-awareness |
| ops, deploy, infra, CI/CD, monitoring | operator, deployer, tracer, measurer | Operational reality needs production experience, deployment expertise, debugging capability, and observability |
| debug, trace, observability, logging | tracer, measurer, benchmarker | Production insight needs high-cardinality debugging, measurement methodology, and performance context |
| plan, scope, wish, feature | questioner, simplifier, architect, ergonomist | Planning cognition needs assumption-challenging, complexity reduction, architectural foresight, and DX awareness |

## Default (no keyword match)

questioner, simplifier, architect

**Rationale:** The core trio covers the most common failure modes: solving the wrong problem (questioner), over-engineering (simplifier), and short-term thinking (architect).

## Override

Users can bypass routing with `--members questioner,architect` to force specific members. This is a power-user escape hatch, not the normal path.

## Notes

- Never spawn all 10 unless explicitly requested — compute cost is linear in member count
- 3-4 members per topic is the sweet spot: enough diversity, manageable deliberation time
- The questioner appears in most routes because challenging assumptions has universal value
- Topics may match multiple rows — use the best match, not all matches
