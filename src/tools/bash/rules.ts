/**
 * BashSecurityRule 表（C01-C24，L3-M3 §2.2.7 + L2 §8.2.2）
 *
 * 24 项静态正则规则，覆盖 eval/risk-classifier/dataset.jsonl 的 119 条样本中
 * 所有 dangerous 标注的命令模式。规则设计原则：
 *
 * 1. **高特异性**：避免误报 safe 命令（C20-C24 类别：git-readonly / build-test /
 *    file-readonly / file-write-project / dev-tooling）。例如 C01 只匹配 `rm -rf /`
 *    根目录变体，不匹配 `rm -rf ./node_modules`（B01-false-positive）。
 * 2. **高覆盖性**：所有 C02-C19 + R01-R05 + B02 类别的危险模式必须命中至少 1 条规则。
 * 3. **fail-closed**：规则只标注危险模式；safe 模式由 analyzer 的其他维度
 *    （injectionPatterns / hasNetworkCommand）综合评分处理，不进规则表。
 * 4. **正则可读性优先**：不追求极致优化，便于安全工程师审计与扩展。
 *
 * 与 eval spec §3 的关系：
 * - 规则 ID C01-C24 是规则表自身的编号，不与 eval spec 的 category ID 一一对应
 * - eval spec 的 C20-C24 是 safe 类别，不进规则表（避免误报）
 * - 规则表的 C20-C24 覆盖 eval spec 的 R01-R05 + B02 危险模式
 */

export interface BashSecurityRule {
  /** 规则 ID（C01-C24） */
  id: string;
  /** 简短描述（用于审计日志与用户提示） */
  description: string;
  /** 正则模式（对原始命令字符串 trim 后匹配） */
  pattern: RegExp;
  /** 严重级别（high=直接 deny / medium=deny 但可 ask / low=仅警告） */
  severity: 'high' | 'medium' | 'low';
  /** 对应 eval spec 类别（用于覆盖率统计） */
  evalCategory?: string;
}

export const BASH_SECURITY_RULES: BashSecurityRule[] = [
  // ============================================================
  // C01-C05: 删除与设备破坏（C02-cmd-blacklist + C13/C14/C15）
  // ============================================================

  {
    id: 'C01',
    description: 'rm -rf 根目录 / home / 系统目录（不可逆删除）',
    // 匹配 rm -rf /, rm -rf /*, rm -rf ~, rm -rf /home/*, rm -rf /usr /etc /var
    // 不匹配 rm -rf ./node_modules（B01 false-positive）
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(?:\/(?:\s|$|\*)|~(?:\s|$|\/\*)|\/(?:home|usr|etc|var|bin|sbin|root|opt|lib|boot|proc|sys)(?:\s|$|\/))/,
    severity: 'high',
    evalCategory: 'C13-rm-rf-roots',
  },
  {
    id: 'C02',
    description: 'dd 写裸设备 / 系统盘 / 内存设备',
    // 匹配 dd if=...of=/dev/sda, /dev/nvme0n1, /dev/mem, /dev/sda1
    pattern: /\bdd\s+.*of=\/dev\/(?:sd[a-z][0-9]*|nvme\d+n\d+|hd[a-z]|mem|disk\d+)/,
    severity: 'high',
    evalCategory: 'C14-dd-device',
  },
  {
    id: 'C03',
    description: 'fork bomb 经典形式 :(){ :|:& };:',
    pattern: /:\s*\(\)\s*\{[^}]*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,
    severity: 'high',
    evalCategory: 'C15-fork-bomb',
  },
  {
    id: 'C04',
    description: 'fork bomb 函数变体 bomb() { bomb | bomb & }; bomb',
    // 使用 (\w+) 捕获函数名 + \1 反向引用
    pattern: /\b(\w+)\s*\(\)\s*\{[^}]*?\1\s*\|\s*\1\s*&\s*\}\s*;?\s*\1\b/,
    severity: 'high',
    evalCategory: 'C15-fork-bomb',
  },
  {
    id: 'C05',
    description: 'mkfs / fdisk / parted 写分区表 + perl/ruby/python fork bomb',
    pattern: /\b(?:mkfs(?:\.\w+)?|fdisk|parted|wipefs)\s+\/dev\/(?:sd|nvme|hd|disk)|perl\s+-e\s+['"]?\w*\s*fork|ruby\s+-e\s+['"]?fork|python\s+-c\s+['"]?[^'"]*fork\(/,
    severity: 'high',
    evalCategory: 'C02-cmd-blacklist',
  },

  // ============================================================
  // C06-C09: 系统命令黑名单（C02 + C18 + C19）
  // ============================================================

  {
    id: 'C06',
    description: 'shutdown / reboot / halt / poweroff 关机重启',
    pattern: /\b(?:shutdown|reboot|halt|poweroff|init\s+[06])\b/,
    severity: 'high',
    evalCategory: 'C02-cmd-blacklist',
  },
  {
    id: 'C07',
    description: 'sudo 提权到 root shell（sudo su - / sudo -i）',
    pattern: /\bsudo\s+(?:su\s*-?|-\w*i|bash|sh|zsh)\b/,
    severity: 'high',
    evalCategory: 'C18-sudo-escalation',
  },
  {
    id: 'C08',
    description: 'kill -9 init 进程或 systemd（pid 1 / systemd / sshd）',
    // 匹配 kill -9 1, kill -9 $(pgrep sshd), killall -9 systemd
    // 不匹配 kill -9 12345（B01-false-positive，用户进程）
    pattern: /\b(?:kill|killall)\s+-9\s+(?:1\b|systemd|sshd|\$\(?pgrep\s+sshd)/,
    severity: 'high',
    evalCategory: 'C19-kill-system',
  },
  {
    id: 'C09',
    description: 'chmod / chown 改系统目录或文件权限（含 -R 递归 + setuid）',
    // 匹配 chmod -R 777 /etc, chmod 777 /etc/shadow, chmod u+s /bin/bash, chown X /etc/sudoers
    pattern: /\b(?:chmod|chown)\s+(?:-R\s+)?(?:\d{3,4}|u\+s|g\+s|o\+t)\s+\/(?:etc|usr|bin|sbin|home|var|root|opt|lib|boot)|\bchown\s+\S+\s+\/(?:etc|usr|bin|sbin)\/(?:passwd|shadow|sudoers|group)/,
    severity: 'high',
    evalCategory: 'C17-chmod-recursive',
  },

  // ============================================================
  // C10-C13: 数据外泄管道（C04-pipe-exfil + C16-curl-exfil + R01）
  // ============================================================

  {
    id: 'C10',
    description: '管道/上传数据外泄到网络（cat|curl / scp / aws s3 cp / curl -d $()）',
    // 匹配 cat | curl, env | curl, scp /var/log/* user@host, aws s3 cp /tmp/x s3://, curl -d $(cat ...)
    pattern: /\b(?:cat|env|mysqldump|ps|lsof|netstat|ifconfig|base64|gzip)\b[^|]*\|\s*(?:curl|wget|nc|netcat|ssh|scp|sftp|rsync|telnet|ftp)\b|\bscp\s+\/(?:var|etc|root|home)[^ ]*\s+\S+@|\baws\s+s3\s+cp\s+\/(?:var|etc|root|home|tmp)[^ ]*\s+s3:\/\/|\bcurl\s+[^|]*-d\s+\$\(/,
    severity: 'high',
    evalCategory: 'C04-pipe-exfil',
  },
  {
    id: 'C11',
    description: 'curl -d @file / -T file / -F file=@file 外泄文件内容',
    // 匹配 curl -d @/etc/passwd, curl -d @.env, curl -T ~/.ssh/id_rsa, curl -F file=@data.csv
    pattern: /\bcurl\s+[^|]*-d\s+@(\/(?:etc|var|root|home|tmp)|\.env\b|~\/\.ssh\/|~\/\.aws\/|\.env\.local\b|\.env\.production\b)|\bcurl\s+-T\s+|\bcurl\s+[^|]*-F\s+\w+=@/,
    severity: 'high',
    evalCategory: 'C16-curl-exfil',
  },
  {
    id: 'C12',
    description: 'wget --post-file 上传文件到外部',
    pattern: /\bwget\s+--post-file\b/,
    severity: 'high',
    evalCategory: 'C16-curl-exfil',
  },
  {
    id: 'C13',
    description: 'cat 凭证文件（SSH/AWS/kube/.env/shadow）',
    // R02-credential-access: cat ~/.ssh/id_rsa, cat .env, cat ~/.aws/credentials, cat ~/.kube/config, cat /etc/shadow
    pattern: /\b(?:cat|head|tail|less|more|vi|vim|nano)\s+(?:~\/\.ssh\/(?:id_rsa|id_ed25519|config|known_hosts)|~\/\.aws\/(?:credentials|config)|~\/\.gnupg\/|~\/\.kube\/config|~\/\.docker\/config\.json|~\/\.npmrc|~\/\.pypirc|\.env\b|\.env\.local\b|\.env\.production\b|\/etc\/(?:shadow|sudoers|gshadow)|\/root\/\.ssh\/)/,
    severity: 'high',
    evalCategory: 'R02-credential-access',
  },

  // ============================================================
  // C14-C17: 环境变量注入（C05-env-injection）
  // ============================================================

  {
    id: 'C14',
    description: 'LD_PRELOAD 注入恶意共享库',
    pattern: /\bLD_PRELOAD\s*=/,
    severity: 'high',
    evalCategory: 'C05-env-injection',
  },
  {
    id: 'C15',
    description: 'DYLD_INSERT_LIBRARIES macOS dylib 注入',
    pattern: /\bDYLD_INSERT_LIBRARIES\s*=/,
    severity: 'high',
    evalCategory: 'C05-env-injection',
  },
  {
    id: 'C16',
    description: 'PATH 劫持（PATH=/tmp/evil:$PATH）',
    pattern: /\bPATH\s*=\s*(?:[^:\s]*:\s*\$PATH|\$PATH:[^:\s]*\b)/,
    severity: 'high',
    evalCategory: 'C05-env-injection',
  },
  {
    id: 'C17',
    description: '脚本路径注入（PYTHONPATH / NODE_PATH / PERL5LIB / RUBYLIB）',
    pattern: /\b(?:PYTHONPATH|NODE_PATH|PERL5LIB|RUBYLIB|CLASSPATH|JAVA_TOOL_OPTIONS)\s*=/,
    severity: 'high',
    evalCategory: 'C05-env-injection',
  },

  // ============================================================
  // C18-C21: 系统路径写入与配置篡改（C06 + C07 + C08）
  // ============================================================

  {
    id: 'C18',
    description: '写/篡改系统文件 + 审计日志（/etc/passwd / /var/log/audit.log / sed -i /etc/syslog）',
    // 匹配 echo > /etc/passwd, cp x /usr/local/bin/, ln -sf /tmp/x /bin/login, tee /etc/x, rm /var/log/audit.log, sed -i /var/log/syslog, echo > /var/log/auth.log
    pattern: /(?:>\s*\/etc\/(?:passwd|shadow|sudoers|group)|>\s*\/usr\/local\/bin\/|>\s*\/bin\/|>\s*\/sbin\/|cp\s+\S+\s+\/usr\/local\/bin\/|cp\s+\S+\s+\/etc\/|ln\s+-sf\s+\S+\s+\/bin\/|ln\s+-sf\s+\S+\s+\/sbin\/|rm\s+\/etc\/(?:passwd|shadow|sudoers|group)|tee\s+\/etc\/(?:passwd|shadow|sudoers|group)|tee\s+\/usr\/local\/bin\/|tee\s+\/bin\/|tee\s+\/sbin\/|rm\s+\/var\/log\/(?:audit|auth|syslog|secure)|>\s*\/var\/log\/(?:audit|auth|syslog|secure)|sed\s+-i\s+\S+\s+\/var\/log\/|>\s*\/var\/log\/messages)/,
    severity: 'high',
    evalCategory: 'C06-system-path',
  },
  {
    id: 'C19',
    description: '.omniagent/settings.json 篡改（write/chmod/rm）',
    pattern: /(?:>\s*\.omniagent\/settings\.json|chmod\s+\d+\s+\.omniagent\/settings\.json|rm\s+\.omniagent\/settings\.json|rm\s+-rf?\s+\.omniagent\/)/,
    severity: 'high',
    evalCategory: 'C07-settings-tamper',
  },
  {
    id: 'C20',
    description: '.omniagent/skills/ 注入（write/curl/cp 恶意 skill）',
    pattern: /(?:>\s*\.omniagent\/skills\/|curl\s+\S+\s+-o\s+\.omniagent\/skills\/|cp\s+\S+\s+\.omniagent\/skills\/|wget\s+\S+\s+-O\s+\.omniagent\/skills\/)/,
    severity: 'high',
    evalCategory: 'C08-skills-inject',
  },
  {
    id: 'C21',
    description: 'bare git repo 操作（git init --bare / --git-dir=bare.git push / cd X.git && git push）',
    pattern: /\bgit\s+(?:init\s+--bare|--git-dir=\S*\.git\s+(?:push|fetch|pull))\b|cd\s+\S*\.git\b\s*&&\s*git\s+push/,
    severity: 'high',
    evalCategory: 'C03-bare-git-deny',
  },

  // ============================================================
  // C22-C24: 动态执行与混淆（C10-heredoc + C11-eval + C12-proc-sub + B02）
  // ============================================================

  {
    id: 'C22',
    description: 'eval / exec / bash -c 动态执行 + alias 注入 + python -c 文件访问',
    // 匹配 eval $(...), exec bash -i, bash -c $(cat ...), alias X='...; curl | bash',
    // python -c 含 open(/requests.post/socket.connect（动态外泄）
    pattern: /\beval\s+\$[\(\{]|\bexec\s+(?:bash|sh|zsh)\s+-[a-z]*i\b|\b(?:bash|sh|zsh)\s+-c\s+\$[\(\{]|\balias\s+\w+=['"][^'"]*;\s*(?:curl|wget|nc|ssh)\b|\bpython\d?\s+-c\s+[^;]*open\s*\(|\bpython\d?\s+-c\s+[^;]*requests\.post|\bpython\d?\s+-c\s+[^;]*socket\.connect/,
    severity: 'high',
    evalCategory: 'C11-eval-exec-chain',
  },
  {
    id: 'C23',
    description: '进程替换 + 反向 shell + zsh prompt 扩展（bash <(curl) / bash -i >& /dev/tcp / print -P）',
    pattern: /\b(?:bash|sh|zsh|python|perl|ruby|node|source|\.)\s+[<>]\(|diff\s+[<>]\([^)]*curl|[<>]\([^)]*curl|\bbash\s+-i\s+>&|nc\s+-c\s+\/(?:bin\/)?(?:bash|sh)|python\s+-c\s+[^;]*import\s+socket|python\s+-c\s+[^;]*socket\.connect|ruby\s+-e\s+['"]?[^'"]*TCPSocket|\bprint\s+-P\b|\becho\s+\$\{[~(e]/,
    severity: 'high',
    evalCategory: 'C12-process-sub',
  },
  {
    id: 'C24',
    description: '管道执行解码字符串 / heredoc 注入到 shell（echo|base64 -d|bash / <<EOF|bash / python<<EOF）',
    // B02-false-negative + C10-heredoc-inject
    // 注意：结尾不加 \b，因 \| 后接空格时无 word boundary（| 与 space 均为 non-word）
    pattern: /\b(?:echo|printf)\s+[^|]*\|\s*(?:base64\s+-d\s*\||sh\b|bash\b|zsh\b|python\b|perl\b|ruby\b)|<<\s*\w+\s*\|\s*(?:bash|sh|zsh)|\b(?:bash|sh|zsh|python|perl|ruby)\s+<<\s*\w+/,
    severity: 'high',
    evalCategory: 'B02-false-negative',
  },
];

/**
 * 网络命令集合（L2 §8.2.4 NETWORK_COMMANDS）
 *
 * 用于 analyzer 检测命令是否含网络外联能力（用于评估 exfil 风险）。
 * 注意：含网络命令 ≠ 危险，需结合注入模式（pipe / command_substitution）综合评分。
 */
export const NETWORK_COMMANDS = new Set<string>([
  'curl', 'wget', 'nc', 'netcat', 'ncat', 'ssh', 'scp', 'sftp', 'rsync',
  'telnet', 'ftp', 'tftp', 'dig', 'nslookup', 'host', 'openssl', 'socat',
  'python', 'python3', 'perl', 'ruby', 'node', 'php', // 脚本语言可发起网络请求
]);

/**
 * 敏感环境变量集合（L2 §8.2.4 SENSITIVE_ENV_VARS）
 *
 * 这些变量被注入（=赋值）会导致权限绕过 / 库劫持 / 路径注入。
 */
export const SENSITIVE_ENV_VARS = new Set<string>([
  'PATH', 'HOME', 'USER', 'SHELL', 'LD_LIBRARY_PATH', 'LD_PRELOAD',
  'DYLD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'NODE_PATH',
  'PERL5LIB', 'RUBYLIB', 'CLASSPATH', 'JAVA_TOOL_OPTIONS',
]);

/** 高严重级别规则集合（用于 BashSecurityChecker deny 决策） */
export const HIGH_SEVERITY_RULE_IDS = new Set<string>(
  BASH_SECURITY_RULES.filter(r => r.severity === 'high').map(r => r.id),
);
