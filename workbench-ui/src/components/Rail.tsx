import type { Contact } from '../data/contacts';

interface Props {
  activeTab: 'msg' | 'contact' | 'fav' | 'file' | 'moments';
  onTabChange: (t: Props['activeTab']) => void;
  onHamburger: () => void;
  onQuickAdd: () => void;
  avatarLetter: string;
  agents: Contact[];
}

/** 第一列：玻璃栏 —— 头像 / 5 tab / agent-list / 汉堡
 *  原型 class 完全保留以承载 CSS Modules-free 的全局样式（保真 1:1）。
 */
export default function Rail({ activeTab, onTabChange, onHamburger, onQuickAdd, avatarLetter, agents }: Props) {
  const tabs: { id: Props['activeTab']; cls: string }[] = [
    { id: 'msg',     cls: 'tab-msg' },
    { id: 'contact', cls: 'tab-contact' },
    { id: 'fav',     cls: 'tab-fav' },
    { id: 'file',    cls: 'tab-file' },
    { id: 'moments', cls: 'tab-moments' },
  ];

  return (
    <nav className="rail" aria-label="主导航">
      {/* 头像 / 菜单方块（顶部） */}
      <button className="menu-btn" data-region="nav-menu" aria-label="主菜单" type="button">
        <span className="user-avatar-ico">{avatarLetter}</span>
      </button>

      {/* 5 个 Tab */}
      {tabs.map((t, i) => (
        <button
          key={t.id}
          className={`tab ${t.cls} ${activeTab === t.id ? 'selected' : ''}`}
          style={{ top: `${72 + i * 50}px` }}
          onClick={() => onTabChange(t.id)}
          aria-label={t.id}
          type="button"
        />
      ))}

      {/* 汉堡（底部） */}
      <div
        className="hamburger"
        role="button"
        aria-label="更多"
        onClick={onHamburger}
      >
        <span /><span /><span />
      </div>

      {/* agent-list：第一列智能体方块（头像态用；此处简化为图标按钮） */}
      <div className="agent-list" aria-label="项目与智能体">
        {agents.map((a) => (
          <div
            key={a.id}
            className="agent-chip"
            title={a.name}
            style={{
              ['--chip-bg' as any]: `linear-gradient(135deg, ${a.c1}, ${a.c2})`,
            }}
            onClick={() => onQuickAdd()}
          />
        ))}
        <button className="rail-quick-add" aria-label="快捷创建智能体" onClick={onQuickAdd} type="button">
          <i className="qadd-h" />
          <i className="qadd-v" />
        </button>
      </div>
    </nav>
  );
}