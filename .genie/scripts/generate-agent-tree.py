#!/usr/bin/env python3
"""
Generate Agent Neural Tree

Creates visual Mermaid diagram and markdown documentation of agent hierarchy.
Auto-updates sections in README.md and .genie/README.md.

Outputs:
- Mermaid flowchart → README.md (visual for users)
- Markdown tree → .genie/README.md (documentation for developers)
"""

import sys
import re
from pathlib import Path
from collections import defaultdict


def scan_agents(root_path):
    """Scan .genie/agents/ folder and categorize agents."""
    agents_path = root_path / '.genie' / 'agents'

    agents = {
        'universal_neurons': [],
        'code_neurons': [],
        'create_neurons': [],
        'orchestrators': [],
        'git_workflows': [],
    }

    # Universal neurons
    neurons_path = agents_path / 'neurons'
    if neurons_path.exists():
        for agent_file in neurons_path.glob('*.md'):
            agents['universal_neurons'].append({
                'name': agent_file.stem,
                'path': agent_file.relative_to(root_path),
                'full_path': agent_file,
            })

    # Code template
    code_path = agents_path / 'code'
    if code_path.exists():
        # Code orchestrator
        code_md = code_path / 'code.md'
        if code_md.exists():
            agents['orchestrators'].append({
                'name': 'code',
                'path': code_md.relative_to(root_path),
                'full_path': code_md,
            })

        # Code neurons
        code_neurons_path = code_path / 'neurons'
        if code_neurons_path.exists():
            for agent_file in code_neurons_path.glob('*.md'):
                agents['code_neurons'].append({
                    'name': agent_file.stem,
                    'path': agent_file.relative_to(root_path),
                    'full_path': agent_file,
                })

            # Git neuron and workflows
            git_path = code_neurons_path / 'git'
            if git_path.exists():
                # Git core neuron
                git_md = git_path / 'git.md'
                if git_md.exists():
                    agents['code_neurons'].append({
                        'name': 'git',
                        'path': git_md.relative_to(root_path),
                        'full_path': git_md,
                    })

                # Git workflows
                git_workflows_path = git_path / 'workflows'
                if git_workflows_path.exists():
                    for workflow_file in git_workflows_path.glob('*.md'):
                        agents['git_workflows'].append({
                            'name': workflow_file.stem,
                            'path': workflow_file.relative_to(root_path),
                            'full_path': workflow_file,
                        })

    # Create template
    create_path = agents_path / 'create'
    if create_path.exists():
        # Create orchestrator
        create_md = create_path / 'create.md'
        if create_md.exists():
            agents['orchestrators'].append({
                'name': 'create',
                'path': create_md.relative_to(root_path),
                'full_path': create_md,
            })

        # Create neurons
        create_neurons_path = create_path / 'neurons'
        if create_neurons_path.exists():
            for agent_file in create_neurons_path.glob('*.md'):
                agents['create_neurons'].append({
                    'name': agent_file.stem,
                    'path': agent_file.relative_to(root_path),
                    'full_path': agent_file,
                })

    return agents


def extract_delegations(agent_file):
    """Extract MCP delegation calls from agent file."""
    try:
        content = agent_file.read_text(encoding='utf-8')
    except Exception:
        return []

    # Pattern: mcp__genie__run with agent="<name>"
    pattern = r'mcp__genie__run.*?agent=["\']([^"\']+)["\']'
    matches = re.findall(pattern, content, re.DOTALL)

    return list(set(matches))  # Deduplicate


def generate_mermaid(agents):
    """Generate Mermaid flowchart diagram."""
    lines = []

    lines.append("```mermaid")
    lines.append("graph TB")
    lines.append("    %% Genie Agent Neural Tree")
    lines.append("")

    # Universal neurons
    lines.append("    %% Universal Neurons (17)")
    lines.append("    UNIVERSAL[Universal Neurons]:::universal")
    for agent in sorted(agents['universal_neurons'], key=lambda x: x['name'])[:5]:
        lines.append(f"    {agent['name']}[{agent['name']}]:::neuron")
        lines.append(f"    UNIVERSAL --> {agent['name']}")
    if len(agents['universal_neurons']) > 5:
        lines.append(f"    more_universal[...{len(agents['universal_neurons']) - 5} more]:::more")
        lines.append("    UNIVERSAL --> more_universal")
    lines.append("")

    # Code template
    lines.append("    %% Code Template")
    lines.append("    CODE[Code Orchestrator]:::orchestrator")
    for agent in sorted(agents['code_neurons'], key=lambda x: x['name'])[:4]:
        lines.append(f"    code_{agent['name']}[{agent['name']}]:::code_neuron")
        lines.append(f"    CODE --> code_{agent['name']}")
    if len(agents['code_neurons']) > 4:
        lines.append(f"    more_code[...{len(agents['code_neurons']) - 4} more]:::more")
        lines.append("    CODE --> more_code")

    # Git workflows
    if agents['git_workflows']:
        lines.append("")
        lines.append("    %% Git Workflows")
        git_agent = next((a for a in agents['code_neurons'] if a['name'] == 'git'), None)
        if git_agent:
            lines.append("    code_git --> git_issue[issue]:::workflow")
            lines.append("    code_git --> git_pr[pr]:::workflow")
            lines.append("    code_git --> git_report[report]:::workflow")

    lines.append("")

    # Create template
    if any(a['name'] == 'create' for a in agents['orchestrators']):
        lines.append("    %% Create Template")
        lines.append("    CREATE[Create Orchestrator]:::orchestrator")
        for agent in sorted(agents['create_neurons'], key=lambda x: x['name']):
            lines.append(f"    create_{agent['name']}[{agent['name']}]:::create_neuron")
            lines.append(f"    CREATE --> create_{agent['name']}")

    lines.append("")
    lines.append("    %% Styling")
    lines.append("    classDef universal fill:#e1f5ff,stroke:#0288d1,stroke-width:2px")
    lines.append("    classDef orchestrator fill:#fff3e0,stroke:#f57c00,stroke-width:3px")
    lines.append("    classDef neuron fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px")
    lines.append("    classDef code_neuron fill:#e8f5e9,stroke:#388e3c,stroke-width:2px")
    lines.append("    classDef create_neuron fill:#fce4ec,stroke:#c2185b,stroke-width:2px")
    lines.append("    classDef workflow fill:#fff9c4,stroke:#fbc02d,stroke-width:1px")
    lines.append("    classDef more fill:#f5f5f5,stroke:#9e9e9e,stroke-width:1px,stroke-dasharray: 5 5")
    lines.append("```")

    return '\n'.join(lines)


def generate_markdown_tree(agents):
    """Generate detailed markdown tree documentation."""
    lines = []

    lines.append("## Agent Neural Tree")
    lines.append("")
    lines.append("**Auto-generated** from `.genie/agents/` folder structure")
    lines.append("")

    # Summary
    total = sum(len(v) for v in agents.values())
    lines.append("**Summary:**")
    lines.append(f"- Universal neurons: {len(agents['universal_neurons'])}")
    lines.append(f"- Code neurons: {len(agents['code_neurons'])}")
    lines.append(f"- Git workflows: {len(agents['git_workflows'])}")
    lines.append(f"- Create neurons: {len(agents['create_neurons'])}")
    lines.append(f"- Orchestrators: {len(agents['orchestrators'])}")
    lines.append(f"- **Total: {total} agents**")
    lines.append("")

    # Universal neurons
    lines.append("### Universal Neurons (Shared)")
    lines.append("")
    for agent in sorted(agents['universal_neurons'], key=lambda x: x['name']):
        delegations = extract_delegations(agent['full_path'])
        if delegations:
            lines.append(f"- **{agent['name']}** → {', '.join(f'`{d}`' for d in delegations)}")
        else:
            lines.append(f"- **{agent['name']}**")
    lines.append("")

    # Code template
    lines.append("### Code Template")
    lines.append("")
    lines.append("**Orchestrator:** `code`")
    lines.append("")
    lines.append("**Neurons:**")
    for agent in sorted(agents['code_neurons'], key=lambda x: x['name']):
        delegations = extract_delegations(agent['full_path'])
        if delegations:
            lines.append(f"- **{agent['name']}** → {', '.join(f'`{d}`' for d in delegations)}")
        else:
            lines.append(f"- **{agent['name']}**")

    if agents['git_workflows']:
        lines.append("")
        lines.append("**Git workflows:** `issue`, `pr`, `report`")

    lines.append("")

    # Create template
    if agents['create_neurons']:
        lines.append("### Create Template")
        lines.append("")
        lines.append("**Orchestrator:** `create`")
        lines.append("")
        lines.append("**Neurons:**")
        for agent in sorted(agents['create_neurons'], key=lambda x: x['name']):
            lines.append(f"- **{agent['name']}**")
        lines.append("")

    return '\n'.join(lines)


def update_file_section(file_path, marker_start, marker_end, new_content):
    """Update section between markers in file."""
    if not file_path.exists():
        print(f"⚠️  File not found: {file_path}")
        return False

    content = file_path.read_text(encoding='utf-8')

    # Find markers
    start_pattern = re.escape(marker_start)
    end_pattern = re.escape(marker_end)
    pattern = f"({start_pattern}).*?({end_pattern})"

    if not re.search(pattern, content, re.DOTALL):
        print(f"⚠️  Markers not found in {file_path}")
        print(f"   Expected: {marker_start} ... {marker_end}")
        return False

    # Replace content between markers
    replacement = f"\\1\n{new_content}\n\\2"
    new_file_content = re.sub(pattern, replacement, content, flags=re.DOTALL)

    file_path.write_text(new_file_content, encoding='utf-8')
    return True


def main():
    """Generate and update agent neural tree."""
    repo_root = Path(__file__).parent.parent.parent

    print("🔍 Scanning .genie/agents/ structure...")
    agents = scan_agents(repo_root)

    total = sum(len(v) for v in agents.values())
    print(f"   Found {total} agents total")
    print(f"   - Universal neurons: {len(agents['universal_neurons'])}")
    print(f"   - Code neurons: {len(agents['code_neurons'])}")
    print(f"   - Git workflows: {len(agents['git_workflows'])}")
    print(f"   - Create neurons: {len(agents['create_neurons'])}")
    print(f"   - Orchestrators: {len(agents['orchestrators'])}")

    # Generate outputs
    print("\n🌲 Generating Mermaid diagram...")
    mermaid_chart = generate_mermaid(agents)

    print("📝 Generating markdown tree...")
    markdown_tree = generate_markdown_tree(agents)

    # Update README.md with Mermaid chart
    readme_path = repo_root / 'README.md'
    print(f"\n📄 Updating {readme_path.relative_to(repo_root)}...")

    success = update_file_section(
        readme_path,
        "<!-- AGENT_TREE_START -->",
        "<!-- AGENT_TREE_END -->",
        mermaid_chart
    )

    if success:
        print(f"   ✅ Mermaid chart updated")
    else:
        print(f"   ⚠️  Could not update Mermaid chart (markers missing)")

    # Update .genie/README.md with markdown tree
    genie_readme_path = repo_root / '.genie' / 'README.md'
    print(f"\n📄 Updating {genie_readme_path.relative_to(repo_root)}...")

    success = update_file_section(
        genie_readme_path,
        "<!-- NEURAL_TREE_START -->",
        "<!-- NEURAL_TREE_END -->",
        markdown_tree
    )

    if success:
        print(f"   ✅ Markdown tree updated")
    else:
        print(f"   ⚠️  Could not update markdown tree (markers missing)")

    print("\n✨ Agent neural tree generation complete!")
    print(f"   - README.md: Mermaid flowchart")
    print(f"   - .genie/README.md: Detailed markdown tree")

    return 0


if __name__ == "__main__":
    sys.exit(main())
