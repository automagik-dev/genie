/**
 * Project Management Tools
 * Category 2: CRUD operations for projects
 */

import { z } from 'zod';
import { ForgeClient } from '../lib/forge-client.js';

export function registerProjectTools(server: any, client: ForgeClient) {
  // Tool: forge_list_projects
  server.addTool({
    name: 'forge_list_projects',
    description: 'List all projects in the workspace. Projects contain tasks and map to git repositories.',
    parameters: z.object({}),
    annotations: {
      readOnlyHint: true
    },
    execute: async (_args: any, { log }: any) => {
      log.info('Listing all projects...');
      const projects: any = await client.listProjects();

      if (!projects || projects.length === 0) {
        return 'No projects found. Create a project with forge_create_project.';
      }

      return `Found ${projects.length} project(s):\n${JSON.stringify(projects, null, 2)}`;
    }
  });

  // Tool: forge_create_project
  server.addTool({
    name: 'forge_create_project',
    description: 'Create a new project. A project represents a git repository and contains tasks.',
    parameters: z.object({
      name: z.string().describe('Project name (e.g., "my-app")'),
      repo_path: z.string().describe('Absolute path to git repository (e.g., "/Users/me/projects/my-app")'),
      setup_script: z.string().optional().describe('Optional setup script to run (e.g., "npm install")'),
      dev_script: z.string().optional().describe('Optional dev server script (e.g., "npm run dev")')
    }),
    execute: async (args: any, { log }: any) => {
      log.info(`Creating project: ${args.name}...`);
      const project: any = await client.createProject({
        name: args.name,
        repo_path: args.repo_path,
        setup_script: args.setup_script,
        dev_script: args.dev_script
      });

      log.info(`Project created: ${project.id}`);
      return `Project created successfully:\n${JSON.stringify(project, null, 2)}`;
    }
  });

  // Tool: forge_get_project
  server.addTool({
    name: 'forge_get_project',
    description: 'Get detailed information about a specific project.',
    parameters: z.object({
      project_id: z.string().describe('Project UUID')
    }),
    annotations: {
      readOnlyHint: true
    },
    execute: async (args: any, { log }: any) => {
      log.info(`Fetching project: ${args.project_id}...`);
      const project = await client.getProject(args.project_id);

      return `Project Details:\n${JSON.stringify(project, null, 2)}`;
    }
  });

  // Tool: forge_update_project
  server.addTool({
    name: 'forge_update_project',
    description: 'Update project details (name, scripts, etc).',
    parameters: z.object({
      project_id: z.string().describe('Project UUID'),
      name: z.string().optional().describe('New project name'),
      setup_script: z.string().optional().describe('New setup script'),
      dev_script: z.string().optional().describe('New dev server script')
    }),
    execute: async (args: any, { log }: any) => {
      log.info(`Updating project: ${args.project_id}...`);
      const { project_id, ...updates } = args;
      const project = await client.updateProject(project_id, updates);

      log.info('Project updated successfully');
      return `Project updated:\n${JSON.stringify(project, null, 2)}`;
    }
  });

  // Tool: forge_delete_project
  server.addTool({
    name: 'forge_delete_project',
    description: 'Delete a project (removes from database, does NOT delete filesystem). WARNING: This action cannot be undone.',
    parameters: z.object({
      project_id: z.string().describe('Project UUID')
    }),
    execute: async (args: any, { log }: any) => {
      log.warn(`Deleting project: ${args.project_id}...`);
      await client.deleteProject(args.project_id);

      log.info('Project deleted successfully');
      return `Project ${args.project_id} deleted successfully.`;
    }
  });

  // Tool: forge_list_project_branches
  server.addTool({
    name: 'forge_list_project_branches',
    description: 'List all git branches in a project repository.',
    parameters: z.object({
      project_id: z.string().describe('Project UUID')
    }),
    annotations: {
      readOnlyHint: true
    },
    execute: async (args: any, { log }: any) => {
      log.info(`Listing branches for project: ${args.project_id}...`);
      const branches = await client.listProjectBranches(args.project_id);

      return `Git Branches:\n${JSON.stringify(branches, null, 2)}`;
    }
  });

  // Tool: forge_search_project_files
  server.addTool({
    name: 'forge_search_project_files',
    description: 'Search for files in a project repository by filename, directory name, or full path.',
    parameters: z.object({
      project_id: z.string().describe('Project UUID'),
      query: z.string().describe('Search term (filename, directory, or path)'),
      mode: z.enum(['FileName', 'DirectoryName', 'FullPath']).optional().default('FileName').describe('Search mode')
    }),
    annotations: {
      readOnlyHint: true
    },
    execute: async (args: any, { log }: any) => {
      log.info(`Searching files in project: ${args.project_id} (query: "${args.query}", mode: ${args.mode})...`);
      const results: any = await client.searchProjectFiles(args.project_id, args.query, args.mode);

      if (!results || results.length === 0) {
        return `No files found matching "${args.query}"`;
      }

      return `Found ${results.length} file(s):\n${JSON.stringify(results, null, 2)}`;
    }
  });
}
