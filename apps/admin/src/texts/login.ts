// Admin login copy (F1-06h; design-hifi AdmLogin, AdmLoginTotp, AdmLoginTotpBind,
// AdmLoginTotpBindInvalid, AdmLoginTotpBindDone). Error lines are BR-TEXT-14 tables A and B
// verbatim (规划/08 12_TEXT, SPEC_REF ecacd64). Admin copy stays here, not in
// contracts/texts.default.json (规划/03 §9).
//
// The change-password step has no artboard: its lines (`password.*`) are 代理补全，待设计补稿
// (F1-frontend/needs.md, design-diffs.md). `error.network`, `field.*` and `bind.secret_*` have no
// 08 key or artboard either (agent default).
export type LoginTexts = Readonly<Record<string, string>>;

const texts = {
  // Errors (BR-TEXT-14).
  'error.10001': '请先登录',
  'error.10001.login_ticket_expired': '登录步骤已过期，请重新登录',
  'error.10008': '账号或密码不正确',
  'error.10009': '连续输错次数过多，账号已锁定，请在 {unlock_time} 后再试',
  'error.10009.no_time': '账号已锁定，请稍后再试',
  'error.10403': '请在 App 内操作',
  'error.10403.admin_ip_not_allowed': '仅限公司网络访问',
  'error.10403.admin_permission_denied': '当前账号没有这项操作的权限，请联系超级管理员开通',
  'error.20001': '填写内容有误，请检查',
  'error.20002': '验证码错误，请重新输入',
  'error.20002.totp_invalid': '动态码不正确，请输入验证器上最新的 6 位动态码',
  'error.20002.totp_bind_invalid':
    '动态码不正确，绑定没有完成。请确认手机时间准确，再输入验证器上最新的 6 位动态码。',
  'error.42901': '操作太频繁，请稍后再试',
  'error.5xxxx': '出了点问题，请稍后再试（{trace6}）',
  'error.5xxxx.no_trace': '出了点问题，请稍后再试',
  'error.unknown': '操作未完成，请稍后再试',
  'error.network': '网络异常，请检查网络后重试',

  // Shared frame.
  brand: '凑狸管理后台',
  'brand.logo': '凑',
  footer: '凑狸内部系统 · 所有操作都会记入操作日志',
  'env.test': '测试环境',
  'steps.label': '登录步骤',
  'steps.credentials': '账号密码',
  'steps.totp': '动态码',
  'steps.bind': '绑定身份验证器',
  'steps.done': '已完成',
  switch_account: '换账号',
  back: '返回上一步',
  next: '下一步',

  // Step 1: account and password (AdmLogin).
  'credentials.title': '请使用后台账号登录',
  'credentials.username': '账号',
  'credentials.password': '密码',
  'credentials.required': '必填',
  'credentials.show_password': '显示密码',
  'credentials.hide_password': '隐藏密码',
  'credentials.note':
    '仅限公司网络访问。连续输错 5 次，账号锁定 30 分钟。忘记密码请联系超级管理员重置。',
  'field.username_required': '请输入账号',
  'field.password_required': '请输入密码',
  // Beside a field the server named in 20001 data.fields (the alert line is error.20001).
  'field.invalid': '这一项填写有误，请检查',

  // Change the initial password (no artboard: 代理补全，待设计补稿).
  'password.title': '设置新密码',
  'password.step': '设置新密码',
  'password.intro':
    '这是本账号第一次登录，请先把初始密码换成只有你知道的新密码，再绑定身份验证器。',
  'password.new': '新密码',
  'password.confirm': '再次输入',
  'password.new_required': '请输入新密码',
  'password.mismatch': '两次输入的新密码不一致',

  // Step 2: dynamic code (AdmLoginTotp).
  'totp.title': '第二步：输入动态码',
  'totp.label': '动态码',
  'totp.hint': '请输入身份验证器中的 6 位动态码',
  'totp.submit': '登录',
  'totp.help': '无法获取动态码？请联系超级管理员',

  // Step 2 for a new account: bind the authenticator (AdmLoginTotpBind / BindInvalid).
  'bind.title': '第二步：绑定身份验证器（首次登录）',
  'bind.pending_tag': '动态码待绑定',
  'bind.intro':
    '这是本账号第一次登录，需要先绑定身份验证器。绑定后，每次登录和后台二次验证都要用它生成的 6 位动态码。',
  'bind.invalid_title': '绑定未完成',
  'bind.invalid_desc':
    '动态码校验没有通过，身份验证器还没有绑定到本账号。连续输错 5 次，账号锁定 30 分钟。',
  'bind.step1': '在手机上打开身份验证器 App',
  'bind.step1_hint': '支持「基于时间的一次性密码（TOTP）」的验证器都可以使用',
  'bind.step2': '扫描二维码，添加本账号',
  'bind.qr_label': '二维码（由系统生成，此处为占位）',
  'bind.qr_line1': '二维码',
  'bind.qr_line2': '（由系统生成，',
  'bind.qr_line3': '此处为占位）',
  'bind.manual': '扫不了码时，在验证器里选「手动输入密钥」',
  'bind.account_label': '账户名',
  'bind.account_value': '凑狸管理后台（{username}）',
  'bind.secret_label': '密钥',
  'bind.copy': '复制密钥',
  'bind.copied': '密钥已复制',
  // No artboard (agent default): the secret is still being fetched, or fetching it failed.
  'bind.secret_loading': '正在生成密钥…',
  'bind.secret_retry': '重新获取密钥',
  'bind.type': '类型：基于时间（TOTP），6 位，30 秒一换',
  'bind.step3': '输入验证器上显示的 6 位动态码',
  'bind.label': '动态码',
  'bind.hint': '输入验证器里本账号对应的 6 位动态码，验证通过才算绑定成功',
  'bind.submit': '验证并绑定',
  'bind.help': '遇到问题请联系超级管理员',
  'bind.leave_note':
    '中途离开或返回上一步：绑定不生效，下次登录仍从这一步开始，二维码和密钥重新生成，本页的作废。',

  // Binding done (AdmLoginTotpBindDone).
  'done.subtitle': '绑定完成',
  'done.title': '身份验证器已绑定',
  'done.bound_tag': '动态码已绑定',
  'done.desc': '以后登录和后台二次验证，都输入这个验证器里 {username} 对应的 6 位动态码。',
  'done.landing_title': '进入后台后打开哪一页',
  'done.landing_with': '已勾选权限点的账号：打开左侧菜单里有权限的第一个页面。',
  'done.landing_without':
    '还没有任何权限点（新建账号默认如此）：打开「暂无权限」提示页，只能看报表和本人的操作日志。',
  'done.enter': '进入后台',
  'done.lost': '换手机或丢失验证器时，请联系超级管理员',
} as const satisfies LoginTexts;

export type LoginTextKey = keyof typeof texts;

export function getLoginTexts(): LoginTexts {
  return texts;
}

/** The text for a key, with `{name}` placeholders filled. */
export function loginText(
  key: LoginTextKey,
  values: Readonly<Record<string, string>> = {},
): string {
  return texts[key].replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

/** True when `key` names a line in this dictionary. */
export function isLoginTextKey(key: string): key is LoginTextKey {
  return Object.hasOwn(texts, key);
}
