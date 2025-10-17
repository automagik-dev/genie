#!/usr/bin/env python3
"""
Generate Agent Neural Tree

Creates a visual representation of the agent hierarchy and relationships.
Part of Genie self-updating ecosystem.

Shows:
- Universal neurons (shared across all templates)
- Template-specific neurons (code/create)
- Delegation relationships (agent → subagent)
- Knowledge connections (@ references between agents)

Output: Markdown tree with hierarchy and metadata
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


def extract_references(agent_file):
    """Extract @ references to other agents."""
    try:
        content = agent_file.read_text(encoding='utf-8')
    except Exception:
        return []

    # Pattern: @.genie/agents/<path>.md
    pattern = r'@\.genie/agents/([\w\-./]+\.md)'
    matches = re.findall(pattern, content)

    # Simplify to agent names
    agent_refs = []
    for match in matches:
        # Extract agent name from path
        parts = Path(match).parts
        if len(parts) > 0:
            name = Path(match).stem
            agent_refs.append(name)

    return list(set(agent_refs))  # Deduplicate


def generate_tree(agents, root_path):
    """Generate markdown tree representation."""
    output = []

    output.append("# Genie Agent Neural Tree")
    output.append("")
    output.append("**Generated:** Automatic scan of `.genie/agents/`")
    output.append("")
    output.append("---")
    output.append("")

    # Universal Neurons
    output.append("## Universal Neurons (Shared Across All Templates)")
    output.append("")
    output.append(f"**Count:** {len(agents['universal_neurons'])}")
    output.append("")

    for agent in sorted(agents['universal_neurons'], key=lambda x: x['name']):
        delegations = extract_delegations(agent['full_path'])
        references = extract_references(agent['full_path'])

        output.append(f"### {agent['name']}")
        output.append(f"- **Path:** `{agent['path']}`")

        if delegations:
            output.append(f"- **Delegates to:** {', '.join(f'`{d}`' for d in delegations)}")

        if references:
            output.append(f"- **References:** {', '.join(f'`{r}`' for r in references)}")

        output.append("")

    # Code Template
    output.append("---")
    output.append("")
    output.append("## Code Template")
    output.append("")

    # Code orchestrator
    output.append("### Orchestrator")
    for agent in agents['orchestrators']:
        if agent['name'] == 'code':
            delegations = extract_delegations(agent['full_path'])
            references = extract_references(agent['full_path'])

            output.append(f"- **{agent['name']}** (`{agent['path']}`)")
            if delegations:
                output.append(f"  - Delegates to: {', '.join(f'`{d}`' for d in delegations)}")
            if references:
                output.append(f"  - References: {', '.join(f'`{r}`' for r in references)}")
    output.append("")

    # Code neurons
    output.append(f"### Code-Specific Neurons ({len(agents['code_neurons'])})")
    output.append("")

    for agent in sorted(agents['code_neurons'], key=lambda x: x['name']):
        delegations = extract_delegations(agent['full_path'])
        references = extract_references(agent['full_path'])

        output.append(f"#### {agent['name']}")
        output.append(f"- **Path:** `{agent['path']}`")

        if delegations:
            output.append(f"- **Delegates to:** {', '.join(f'`{d}`' for d in delegations)}")

        if references:
            output.append(f"- **References:** {', '.join(f'`{r}`' for r in references)}")

        output.append("")

    # Git workflows
    if agents['git_workflows']:
        output.append(f"### Git Workflows ({len(agents['git_workflows'])})")
        output.append("")

        for agent in sorted(agents['git_workflows'], key=lambda x: x['name']):
            delegations = extract_delegations(agent['full_path'])
            references = extract_references(agent['full_path'])

            output.append(f"#### {agent['name']}")
            output.append(f"- **Path:** `{agent['path']}`")

            if delegations:
                output.append(f"- **Delegates to:** {', '.join(f'`{d}`' for d in delegations)}")

            if references:
                output.append(f"- **References:** {', '.join(f'`{r}`' for r in references)}")

            output.append("")

    # Create Template
    output.append("---")
    output.append("")
    output.append("## Create Template")
    output.append("")

    # Create orchestrator
    output.append("### Orchestrator")
    for agent in agents['orchestrators']:
        if agent['name'] == 'create':
            delegations = extract_delegations(agent['full_path'])
            references = extract_references(agent['full_path'])

            output.append(f"- **{agent['name']}** (`{agent['path']}`)")
            if delegations:
                output.append(f"  - Delegates to: {', '.join(f'`{d}`' for d in delegations)}")
            if references:
                output.append(f"  - References: {', '.join(f'`{r}`' for r in references)}")
    output.append("")

    # Create neurons
    if agents['create_neurons']:
        output.append(f"### Create-Specific Neurons ({len(agents['create_neurons'])})")
        output.append("")

        for agent in sorted(agents['create_neurons'], key=lambda x: x['name']):
            delegations = extract_delegations(agent['full_path'])
            references = extract_references(agent['full_path'])

            output.append(f"#### {agent['name']}")
            output.append(f"- **Path:** `{agent['path']}`")

            if delegations:
                output.append(f"- **Delegates to:** {', '.join(f'`{d}`' for d in delegations)}")

            if references:
                output.append(f"- **References:** {', '.join(f'`{r}`' for r in references)}")

            output.append("")

    # Summary
    output.append("---")
    output.append("")
    output.append("## Summary")
    output.append("")
    output.append(f"- **Universal neurons:** {len(agents['universal_neurons'])}")
    output.append(f"- **Code neurons:** {len(agents['code_neurons'])}")
    output.append(f"- **Git workflows:** {len(agents['git_workflows'])}")
    output.append(f"- **Create neurons:** {len(agents['create_neurons'])}")
    output.append(f"- **Orchestrators:** {len(agents['orchestrators'])}")
    output.append(f"- **Total agents:** {sum(len(v) for v in agents.values())}")
    output.append("")

    return '\n'.join(output)


def main():
    """Generate agent neural tree."""
    repo_root = Path(__file__).parent.parent.parent

    print("🔍 Scanning .genie/agents/ structure...")
    agents = scan_agents(repo_root)

    print(f"   Found {sum(len(v) for v in agents.values())} agents total")
    print(f"   - Universal neurons: {len(agents['universal_neurons'])}")
    print(f"   - Code neurons: {len(agents['code_neurons'])}")
    print(f"   - Git workflows: {len(agents['git_workflows'])}")
    print(f"   - Create neurons: {len(agents['create_neurons'])}")
    print(f"   - Orchestrators: {len(agents['orchestrators'])}")

    print("\n🌲 Generating neural tree...")
    tree = generate_tree(agents, repo_root)

    # Save to file
    output_path = repo_root / '.genie' / 'reports' / 'agent-neural-tree.md'
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(tree, encoding='utf-8')

    print(f"✅ Agent neural tree generated: {output_path.relative_to(repo_root)}")

    # Also print to stdout
    print("\n" + "="*60)
    print(tree)

    return 0


if __name__ == "__main__":
    sys.exit(main())
