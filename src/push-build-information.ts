import { isDebug } from '@actions/core'
import { context } from '@actions/github'
import {
  BuildInformationRepository,
  Client,
  CreateOctopusBuildInformationCommand,
  IOctopusBuildInformationCommit,
  PackageIdentity
} from '@octopusdeploy/api-client'
import { InputParameters } from './input-parameters'
import { execSync } from 'node:child_process'

type GitCommit = {
  hash: string
  author: string
  date: string
  message: string
}

function getGitTags(): string[] {
  const tags = execSync('git tag --sort=-v:refname', { encoding: 'utf-8' })
  return tags.trim().split('\n')
}

function getGitCommits(from: string, to: string): GitCommit[] {
  const logFormat = `--pretty=format:{\\"hash\\":\\"%H\\",\\"author\\":\\"%an\\",\\"date\\":\\"%ad\\",\\"message\\":\\"%s\\"},`
  const rawLog = execSync(`git log ${from}..${to} ${logFormat}`, { encoding: 'utf-8' })

  const json = `[${rawLog.replace(/,\s*$/, '')}]`
  return JSON.parse(json)
}

function getOctopusBuildInformationCommits(client: Client, version: string): IOctopusBuildInformationCommit[] {
  const versionTag = `v${version}`

  const tags = getGitTags()

  const tagIndex = tags.indexOf(versionTag)

  if (tagIndex === -1) {
    throw new Error(`Tag ${version} not found in the repository. Found tags: ${tags.join(', ')}.`)
  }

  const previousTag = tags[tagIndex + 1]

  const gitCommits: GitCommit[] = getGitCommits(previousTag, versionTag)

  return gitCommits.map(commit => {
    return {
      Id: commit.hash,
      Comment: commit.message
    }
  })
}

export async function pushBuildInformationFromInputs(
  client: Client,
  runId: number,
  parameters: InputParameters
): Promise<void> {
  // get the branch name
  let branch: string = parameters.branch || context.ref
  if (branch.startsWith('refs/heads/')) {
    branch = branch.substring('refs/heads/'.length)
  }

  const repoUri = `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}`

  let commits
  try {
    commits = getOctopusBuildInformationCommits(client, parameters.version)
  } catch (error: unknown) {
    client.error(`Failed to retrieve commits for version ${parameters.version}`)
    throw error
  }

  const packages: PackageIdentity[] = []
  for (const packageId of parameters.packages) {
    packages.push({
      Id: packageId,
      Version: parameters.version
    })
  }

  const command: CreateOctopusBuildInformationCommand = {
    spaceName: parameters.space,
    BuildEnvironment: 'GitHub Actions',
    BuildNumber: context.runNumber.toString(),
    BuildUrl: `${repoUri}/actions/runs/${runId}`,
    Branch: branch,
    VcsType: 'Git',
    VcsRoot: `${repoUri}`,
    VcsCommitNumber: context.sha,
    Commits: commits,
    Packages: packages
  }

  if (isDebug()) {
    client.info(`Build Information:\n${JSON.stringify(command, null, 2)}`)
  }

  const repository = new BuildInformationRepository(client, parameters.space)
  await repository.push(command, parameters.overwriteMode)

  client.info('Successfully pushed build information to Octopus')
}
