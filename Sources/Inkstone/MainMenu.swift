import AppKit

enum MainMenu {
    @MainActor
    static func build(target: AppDelegate) -> NSMenu {
        let main = NSMenu()

        func submenu(_ title: String) -> NSMenu {
            let item = NSMenuItem()
            let menu = NSMenu(title: title)
            item.submenu = menu
            main.addItem(item)
            return menu
        }
        @discardableResult
        func add(_ menu: NSMenu, _ title: String, _ action: Selector?, _ key: String = "",
                 _ modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers
            item.target = target
            menu.addItem(item)
            return item
        }

        let appMenu = submenu("Inkstone")
        add(appMenu, "关于 Inkstone", #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
        appMenu.addItem(.separator())
        add(appMenu, "隐藏 Inkstone", #selector(NSApplication.hide(_:)), "h")
        add(appMenu, "隐藏其他", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
        add(appMenu, "全部显示", #selector(NSApplication.unhideAllApplications(_:)))
        appMenu.addItem(.separator())
        add(appMenu, "退出 Inkstone", #selector(NSApplication.terminate(_:)), "q")

        let file = submenu("文件")
        add(file, "导入 EPUB…", #selector(AppDelegate.importFromMenu(_:)), "o", target: target)
        file.addItem(.separator())
        add(file, "关闭窗口", #selector(NSWindow.performClose(_:)), "w")

        let edit = submenu("编辑")
        add(edit, "撤销", Selector(("undo:")), "z")
        add(edit, "重做", Selector(("redo:")), "z", [.command, .shift])
        edit.addItem(.separator())
        add(edit, "剪切", #selector(NSText.cut(_:)), "x")
        add(edit, "拷贝", #selector(NSText.copy(_:)), "c")
        add(edit, "粘贴", #selector(NSText.paste(_:)), "v")
        add(edit, "全选", #selector(NSText.selectAll(_:)), "a")

        let view = submenu("显示")
        add(view, "进入全屏幕", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
        view.addItem(.separator())
        add(view, "重新载入界面", #selector(AppDelegate.reloadPage(_:)), "r", target: target)

        let window = submenu("窗口")
        add(window, "最小化", #selector(NSWindow.performMiniaturize(_:)), "m")
        add(window, "缩放", #selector(NSWindow.performZoom(_:)))
        NSApp.windowsMenu = window

        return main
    }
}
