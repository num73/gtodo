import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './storage';
import type { FolderStorage } from './folder-storage';
import type { PreferencesStore } from './preferences';
import { emptyGitStatus, gitActionSchema, gitConfigureSchema, type GitAction, type GitConfigure, type GitStatus } from '../src/shared/git';

const runFile = promisify(execFile);
const sanitize = (value: string) => value.replace(/(https?:\/\/)[^\s/@]+@/gi, '$1***@').slice(0, 4000);
export class GitSync {
  constructor(private folders: FolderStorage, private preferences: PreferencesStore, private executable = 'git') {}
  private async run(args: string[], timeout = 60000) {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_MERGE_AUTOEDIT: 'no' };
    for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete env[key as keyof typeof env];
    try { const { stdout } = await runFile(this.executable, ['--no-pager', '-c', 'core.quotePath=false', ...args], { cwd: this.folders.directory, env, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }); return stdout; }
    catch (error) {
      const failure = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
      if (failure.code === 'ENOENT') {
        try { await realpath(this.folders.directory); } catch { throw new Error('数据文件夹暂不可用，请恢复目录后重试。'); }
        throw new Error('未找到 Git，请安装 Git for Windows 后重新启动 GTodo。');
      }
      if (failure.killed) throw new Error('Git 操作超时，请检查网络和仓库认证后重试。');
      throw new Error(sanitize(failure.stderr?.trim() || failure.message));
    }
  }
  private async optional(args: string[]) { try { return (await this.run(args, 10000)).trim(); } catch { return ''; } }
  private async exactRoot() {
    const root = (await this.run(['rev-parse', '--show-toplevel'], 10000)).trim();
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(await realpath(root)) !== normalize(await realpath(this.folders.directory))) throw new Error('当前数据文件夹位于另一个 Git 仓库内。请在设置中初始化独立的数据仓库。');
  }
  private async inspect(): Promise<GitStatus> {
    const result = emptyGitStatus(); result.enabled = this.preferences.value.git.enabled;
    try {
      await this.run(['--version'], 10000); result.installed = true;
      const root = await this.optional(['rev-parse', '--show-toplevel']);
      if (!root) return result;
      await this.exactRoot(); result.repository = true;
      const [branch, remote, userName, userEmail, status, counts] = await Promise.all([
        this.optional(['symbolic-ref', '--short', 'HEAD']), this.optional(['config', '--get', 'remote.origin.url']),
        this.optional(['config', '--get', 'user.name']), this.optional(['config', '--get', 'user.email']),
        this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], 10000), this.optional(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
      ]);
      Object.assign(result, { branch, remote: sanitize(remote), userName, userEmail });
      const entries = status.split('\0');
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]; if (entry.length < 4) continue;
        result.files.push({ path: entry.slice(3), index: entry[0], worktree: entry[1] });
        if (/[RC]/.test(entry.slice(0, 2))) i++;
      }
      const [ahead, behind] = counts.split(/\s+/).map(Number); result.ahead = ahead || 0; result.behind = behind || 0;
    } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
    return result;
  }
  status() { return this.folders.exclusive(() => this.inspect(), false); }
  configure(input: GitConfigure) {
    const values = gitConfigureSchema.parse(input);
    return this.folders.exclusive(async () => {
      if (!values.enabled) { await this.preferences.update(value => { value.git.enabled = false; }); return this.inspect(); }
      await this.run(['--version']);
      if (values.initialize) {
        await this.run(['init', '--initial-branch=main', '.']);
        const ignoreFile = path.join(this.folders.directory, '.gitignore');
        let ignore = ''; try { ignore = await readFile(ignoreFile, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (!ignore.includes('# GTodo local recovery files')) await atomicWrite(ignoreFile, `${ignore}${ignore.endsWith('\n') || !ignore ? '' : '\n'}# GTodo local recovery files\n*.bak\n*.previous\n*.tmp\n`);
      }
      await this.exactRoot();
      if (values.remote !== undefined) {
        const existing = await this.optional(['config', '--get', 'remote.origin.url']);
        if (values.remote) await this.run(['remote', existing ? 'set-url' : 'add', '--', 'origin', values.remote]);
        else if (existing) await this.run(['remote', 'remove', 'origin']);
      }
      for (const [key, value] of [['user.name', values.userName], ['user.email', values.userEmail]]) {
        if (value === undefined) continue;
        if (value) await this.run(['config', '--local', key!, value]);
        else if (await this.optional(['config', '--local', '--get', key!])) await this.run(['config', '--local', '--unset-all', key!]);
      }
      await this.preferences.update(value => { value.git.enabled = true; }); return this.inspect();
    }, values.enabled);
  }
  action(input: GitAction) {
    const action = gitActionSchema.parse(input);
    return this.folders.exclusive(async () => {
      if (!this.preferences.value.git.enabled) throw new Error('请先在设置中启用 Git 同步。');
      await this.exactRoot(); const status = await this.inspect(); if (status.error) throw new Error(status.error);
      if (action.type === 'add') await this.run(['add', '--all', '--', '.']);
      else if (action.type === 'commit') {
        if (!status.files.some(file => file.index !== ' ' && file.index !== '?')) throw new Error('没有暂存的修改，请先执行 Add。');
        if (!status.userName || !status.userEmail) throw new Error('请在 Git 设置中填写提交用户名和邮箱。');
        await this.run(['commit', '-m', action.message]);
      } else {
        if (!status.remote) throw new Error('请先在设置中填写远程仓库地址。');
        if (!status.branch) throw new Error('当前不在分支上，请先在外部 Git 工具中切换到分支。');
        if (action.type === 'pull') {
          if (status.files.length) throw new Error('还有未提交的修改，请先 Add、Commit 后再 Pull。');
          await this.run(['pull', '--ff-only', '--no-rebase', '--', 'origin', status.branch]);
        } else await this.run(['push', '--set-upstream', '--', 'origin', `HEAD:refs/heads/${status.branch}`]);
      }
      return this.inspect();
    }, true, action.type === 'pull');
  }
}
