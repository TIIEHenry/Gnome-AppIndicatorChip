# Gnome-AppIndicatorChip

A fork of [gnome-shell-extension-appindicator](https://github.com/ubuntu/gnome-shell-extension-appindicator) (v53) that adds a Windows-style tray overflow, with a panel entry that doubles as a CPU and memory readout.

本扩展在上游 AppIndicator / KStatusNotifierItem 支持的基础上，增加了类似 Windows 的托盘收纳功能。

## 新增功能

- **托盘收纳**：不常用的托盘图标收进一个弹出面板，面板里按 4 列等距网格排列，图标尺寸统一。
- **CPU / 内存读数入口**：收纳入口不是箭头，而是一个显示 `12 U 76 M` 的读数。数字用数字空格（U+2007）补位，宽度恒定，面板不会随负载抖动。采样方式参考
  [simple-system-monitor](https://github.com/lgiki/gnome-shell-extension-simple-system-monitor)，读取 `/proc/stat` 与 `/proc/meminfo`，每 2 秒刷新。
- **管理列表**：右键收纳入口直接进入管理页，可以用眼睛图标切换某个图标显示在面板还是收纳起来，用上下箭头调整顺序。
- **入口位置可选**：收纳入口可以放在托盘图标组的左侧或右侧。

## 安装

需要 GNOME Shell 42。

```bash
git clone https://github.com/TIIEHenry/Gnome-AppIndicatorChip.git
ln -s "$(pwd)/Gnome-AppIndicatorChip" ~/.local/share/gnome-shell/extensions/appindicator-overflow@tiiehenry.github.io
gnome-extensions enable appindicator-overflow@tiiehenry.github.io
```

在 X11 上按 `Alt+F2` 输入 `r` 重启 Shell，或者注销后重新登录。

## 设置

打开扩展设置即可调整收纳开关、新图标是否默认收纳、收纳入口位置，以及上游原有的图标大小、间距、透明度等选项。

## 许可

与上游一致，GPL-2.0-or-later。
