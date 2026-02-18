# classroom.md

> Workspace-only: Classroom commands require Google Workspace for Education/eligible domain setup.

High-surface service (70+ commands): courses, roster, coursework, materials, submissions, announcements, topics, invitations, guardians.

## Courses
- `gog classroom courses list|get|create|update|archive|unarchive|join|leave|delete|url`

## Roster: students + teachers
- `gog classroom students list|get|add|remove`
- `gog classroom teachers list|get|add|remove`
- `gog classroom roster <courseId>`

## Coursework + materials + topics
- `gog classroom coursework list|get|create|update|delete|assignees`
- `gog classroom materials list|get|create|update|delete`
- `gog classroom topics list|get|create|update|delete`

## Submissions lifecycle
- `gog classroom submissions list|get`
- `gog classroom submissions turn-in|reclaim|return|grade`

## Announcements
- `gog classroom announcements list|get|create|update|delete|assignees`

## Invitations, guardians, profiles
- `gog classroom invitations list|get|create|accept|delete`
- `gog classroom guardians list|get|delete`
- `gog classroom guardian-invitations list|get|create`
- `gog classroom profile get`

## Example
```bash
gog classroom courses list --read-only
gog classroom coursework create <courseId> --title 'Homework 5' --dry-run
gog classroom submissions grade <courseId> <courseWorkId> <submissionId> --draft-grade 95 --dry-run
```
