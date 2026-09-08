// 宿主防火墙（ufw）期望规则的计算。三方互通（宿主 ↔ LXC 容器 ↔ docker 服务）是项目基础，
// 其中「容器访问宿主服务」（ufw INPUT）与「LXC 桥的路由放行」没有常驻守护者——漏一条就是
// 「容器里访问不到服务」，SYN 静默被丢，极难排查（2026-09-03 的 7321 事故）。
//
// 职责分界：
//   这里只「算」：纯读 config 推导期望规则，无需 root、不碰系统（`mysandbox firewall print`）。
//   「应用」在 scripts/mysandbox-firewall.sh（root，scripts/mysandbox-firewall.service 开机跑；
//   config 相关配置变更后手工 restart）。应用侧幂等（已在 ufw status 里就跳过）、只增不删
//   （手敲的历史规则不会被回收；要清理手工 ufw delete）。
//
// 转发层（FORWARD）的分工——本模块只管 LXC 桥这一条 route 放行，其余各有归属：
//   - LXC 网段出网 MASQUERADE：mysandbox-net.service（nat 表，ufw 之前）。
//   - LXC → docker 跨桥：mysandbox-docker-interop.service（raw 表 + DOCKER-USER，ufw 之前）。
//   - docker 服务网段出网：docker 自己往 FORWARD 前端插的 `! -o <桥> ACCEPT`，无需重复。
import type { Config } from './config.js';
import { DOCKER_API_PORT } from './dockerApi.js';

export interface FirewallRule {
  kind: 'input' | 'route';
  // input: '<port>/<proto>' 或 'any'（全端口）；route: 桥设备名
  spec: string;
  // input: 来源网段（CIDR）
  from?: string;
  comment: string;
}

// ipPool.from → /24 网段（前缀取前 3 段，与 gatewayOf 的约定一致）。不是点分 IPv4 返回 null。
function subnetOf(poolFrom: string): string | null {
  const m = poolFrom.match(/^(\d+\.\d+\.\d+)\.\d+$/);
  return m ? `${m[1]}.0/24` : null;
}

export function desiredFirewallRules(config: Config): FirewallRule[] {
  const rules: FirewallRule[] = [];
  const lxcSubnet = subnetOf(config.ipPool.from);

  // LXC 网段 → 宿主 53（udp/tcp）：模板 resolved.conf 的首选上游就是网关 IP（53 监听由宿主
  // systemd-resolved 的 DNSStubListenerExtra 提供），这是容器 DNS 的根基，与监听地址无关。
  if (lxcSubnet) {
    for (const proto of ['udp', 'tcp'] as const) {
      rules.push({
        kind: 'input',
        spec: `53/${proto}`,
        from: lxcSubnet,
        comment: 'mysandbox: LXC containers -> gateway DNS',
      });
    }
  }

  // docker API 桥（cfg.dockerApi.enabled，server/dockerApi.ts）：LXC 网段 → 宿主 2375 的
  // 透传代理（绑网关 IP）。docker = 宿主 root 级能力，来源钉死 LXC 网段——services 网段
  // 的应用容器用不到宿主 docker，不给。
  if (config.dockerApi.enabled && lxcSubnet) {
    rules.push({
      kind: 'input',
      spec: `${DOCKER_API_PORT}/tcp`,
      from: lxcSubnet,
      comment: 'mysandbox: LXC containers -> host docker API bridge',
    });
  }

  // peer API（cfg.peer，server/peer.ts）：LXC 网段 → 网关 IP 的容器间 exec 转发枢纽。
  // 凭据是独立 peerToken（不是控制台主 token），端点只有 targets/exec；来源钉死 LXC
  // 网段——services 网段的应用容器只是被执行目标，不需要调别人，不给。
  if (config.peer?.enabled && lxcSubnet) {
    rules.push({
      kind: 'input',
      spec: `${config.peer.port}/tcp`,
      from: lxcSubnet,
      comment: 'mysandbox: LXC containers -> peer exec API',
    });
  }

  // 非 localhost 监听时才放行容器 → console 端口：localhost（安全默认）下容器反正连不上，
  // 规则不该存在（与 CLI 对非 localhost 监听的警告同一立场）。
  const remote = config.listen.host !== '127.0.0.1' && config.listen.host !== 'localhost';
  if (remote && lxcSubnet) {
    rules.push({
      kind: 'input',
      spec: `${config.listen.port}/tcp`,
      from: lxcSubnet,
      comment: `mysandbox: LXC containers -> mysandbox ${config.listen.port}`,
    });
    if (config.services.enabled) {
      const svcSubnet = subnetOf(config.services.ipPool.from);
      if (svcSubnet) {
        rules.push({
          kind: 'input',
          spec: `${config.listen.port}/tcp`,
          from: svcSubnet,
          comment: `mysandbox: mysandbox-lan services -> mysandbox ${config.listen.port}`,
        });
      }
    }
  }

  // LXC 桥的路由放行（等价于旧 /etc/ufw/before.rules 里手改的 -A ufw-before-forward -i <桥>
  // ACCEPT，那条保留无害；这条走 ufw 自管，可见、可查、随 config 走）。
  rules.push({
    kind: 'route',
    spec: config.network,
    comment: 'mysandbox: routed accept from LXC bridge',
  });

  // 环境特例（config firewall.allow）：热点访问 console、宿主 clash 代理/GLM 网关等。
  for (const r of config.firewall.allow) {
    const comment = r.comment || `mysandbox: allow ${r.from}${r.port ? ` -> ${r.port}` : ''}`;
    if (r.port == null) {
      rules.push({ kind: 'input', spec: 'any', from: r.from, comment });
    } else {
      rules.push({ kind: 'input', spec: `${r.port}/${r.proto ?? 'tcp'}`, from: r.from, comment });
    }
  }

  return rules;
}

// 一次性子命令：mysandbox firewall print（不启动 server、不需要 root）。
// 输出 tab 分隔行，由 scripts/mysandbox-firewall.sh 消费：
//   input\t<port/proto|any>\t<来源网段>\t<comment>
//   route\t<桥设备名>\t<comment>
export async function runFirewallCommand(argv: string[], config: Config): Promise<void> {
  const sub = argv[0] || 'print';
  if (sub !== 'print') {
    process.stderr.write(`>> mysandbox firewall: 未知子命令 '${sub}'（支持: print）\n`);
    process.exit(1);
  }
  for (const r of desiredFirewallRules(config)) {
    if (r.kind === 'route') {
      process.stdout.write(`route\t${r.spec}\t${r.comment}\n`);
    } else {
      process.stdout.write(`input\t${r.spec}\t${r.from}\t${r.comment}\n`);
    }
  }
}
