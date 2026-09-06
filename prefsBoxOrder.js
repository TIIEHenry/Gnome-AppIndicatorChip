// This file is part of the AppIndicator/KStatusNotifierItem GNOME Shell extension
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.

/* exported buildItemOrderPage, flattenInnerScrolls */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;
const Gdk = imports.gi.Gdk;
const Adw = imports.gi.Adw;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Gettext = imports.gettext.domain(
    Me ? Me.metadata['gettext-domain'] : 'AppIndicatorExtension');
const _ = Gettext.gettext;

const TRAY_SLOT = 'appindicator-overflow';
const BOXES = ['left', 'center', 'right'];
const BOX_TITLES = {
    left: _('Left Top Bar Box'),
    center: _('Center Top Bar Box'),
    right: _('Right Top Bar Box'),
};

function slotLabel(slot) {
    if (slot === TRAY_SLOT)
        return _('Tray (overflow + icons)');
    return slot;
}

function dropRow(value) {
    if (!value)
        return null;
    if (value instanceof BoxOrderRow)
        return value;
    if (value.get_object)
        return value.get_object();
    return value;
}

function writeOrders(settings, orders) {
    BOXES.forEach(box => {
        const next = orders[box];
        const current = settings.get_strv(`${box}-box-order`);
        if (JSON.stringify(current) !== JSON.stringify(next))
            settings.set_strv(`${box}-box-order`, next);
    });
    for (const box of BOXES) {
        if (orders[box].includes(TRAY_SLOT)) {
            if (settings.get_string('tray-pos') !== box)
                settings.set_string('tray-pos', box);
            break;
        }
    }
}

function rowsOf(list) {
    const rows = [];
    for (let i = 0; ; i++) {
        const row = list.get_row_at_index(i);
        if (!row)
            break;
        rows.push(row);
    }
    return rows;
}

function itemRowsOf(list) {
    return rowsOf(list).filter(row => row.item);
}

const BoxOrderRow = GObject.registerClass({
    GTypeName: 'AppIndicatorBoxOrderRow',
}, class AppIndicatorBoxOrderRow extends Adw.ActionRow {
    _init(item) {
        super._init({ title: slotLabel(item) });
        this.item = item;

        const handle = new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
        });
        this.add_prefix(handle);

        const menu = new Gio.Menu();
        menu.append(_('Forget'), 'row.forget');
        const options = new Gtk.MenuButton({
            icon_name: 'view-more-symbolic',
            menu_model: menu,
            has_frame: false,
            valign: Gtk.Align.CENTER,
        });
        this.add_suffix(options);

        const forget = new Gio.SimpleAction({ name: 'forget' });
        forget.connect('activate', () => {
            if (this._controller)
                this._controller.forgetRow(this);
        });
        const group = new Gio.SimpleActionGroup();
        group.add_action(forget);
        this.insert_action_group('row', group);

        const drag = new Gtk.DragSource({ actions: Gdk.DragAction.MOVE });
        drag.connect('prepare', (_source, x, y) => {
            this._dragX = x;
            this._dragY = y;
            const value = new GObject.Value();
            value.init(BoxOrderRow);
            value.set_object(this);
            return Gdk.ContentProvider.new_for_value(value);
        });
        drag.connect('drag-begin', (_source, gdkDrag) => {
            const icon = Gtk.DragIcon.get_for_drag(gdkDrag);
            const ghost = new BoxOrderRow(this.item);
            ghost.set_size_request(this.get_allocated_width(),
                this.get_allocated_height());
            icon.set_child(ghost);
            gdkDrag.set_hotspot(this._dragX || 0, this._dragY || 0);
        });
        this.add_controller(drag);

        const drop = new Gtk.DropTarget({
            actions: Gdk.DragAction.MOVE,
            formats: Gdk.ContentFormats.new_for_gtype(BoxOrderRow),
        });
        drop.connect('drop', (_target, value, _x, y) => {
            const source = dropRow(value);
            if (!source || source === this || !this._controller)
                return false;
            const after = typeof y === 'number' &&
                y > this.get_allocated_height() / 2;
            this._controller.dropOnRow(source, this, after);
            return true;
        });
        this.add_controller(drop);

        const motion = new Gtk.DropControllerMotion();
        motion.connect('motion', (_c, _x, y) => {
            const after = y > this.get_allocated_height() / 2;
            this.remove_css_class('appindicator-drop-before');
            this.remove_css_class('appindicator-drop-after');
            this.add_css_class(after
                ? 'appindicator-drop-after'
                : 'appindicator-drop-before');
        });
        motion.connect('leave', () => {
            this.remove_css_class('appindicator-drop-before');
            this.remove_css_class('appindicator-drop-after');
        });
        this.add_controller(motion);
    }
});

function makePlaceholder(controller, list) {
    const row = new Adw.ActionRow({
        title: _('Drop items here'),
        activatable: false,
        selectable: false,
    });
    row._placeholder = true;
    const drop = new Gtk.DropTarget({
        actions: Gdk.DragAction.MOVE,
        formats: Gdk.ContentFormats.new_for_gtype(BoxOrderRow),
    });
    drop.connect('drop', (_target, value) => {
        const source = dropRow(value);
        if (!source || source._placeholder)
            return false;
        controller.dropOnList(source, list, 0);
        return true;
    });
    row.add_controller(drop);
    return row;
}

function installListDrop(controller, list) {
    const drop = new Gtk.DropTarget({
        actions: Gdk.DragAction.MOVE,
        formats: Gdk.ContentFormats.new_for_gtype(BoxOrderRow),
    });
    drop.connect('drop', (_target, value) => {
        const source = dropRow(value);
        if (!source || source._placeholder)
            return false;
        controller.dropOnList(source, list, -1);
        return true;
    });
    list.add_controller(drop);
}

function bindLists(settings, lists) {
    const controller = {
        _saving: false,
        save() {
            const orders = {};
            BOXES.forEach(box => {
                orders[box] = itemRowsOf(lists[box]).map(row => row.item);
            });
            this._saving = true;
            try {
                writeOrders(settings, orders);
            } finally {
                this._saving = false;
            }
        },
        refreshPlaceholders() {
            BOXES.forEach(box => {
                const list = lists[box];
                const items = itemRowsOf(list);
                if (!items.length && !list._placeholder) {
                    list._placeholder = makePlaceholder(this, list);
                    list.append(list._placeholder);
                } else if (items.length && list._placeholder) {
                    list.remove(list._placeholder);
                    list._placeholder.destroy();
                    list._placeholder = null;
                }
            });
        },
        dropOnRow(source, target, after) {
            if (!source || !target || source === target || source._placeholder)
                return;
            if (target._placeholder) {
                this.dropOnList(source, target.get_parent(), 0);
                return;
            }
            const targetList = target.get_parent();
            if (!targetList)
                return;
            let index = target.get_index();
            if (after)
                index += 1;
            this.dropOnList(source, targetList, index);
        },
        dropOnList(source, list, index) {
            if (!source || !list || source._placeholder)
                return;
            const sourceList = source.get_parent();
            if (sourceList === list) {
                const current = source.get_index();
                if (index < 0)
                    index = itemRowsOf(list).length;
                if (index === current || index === current + 1)
                    return;
                sourceList.remove(source);
                if (current < index)
                    index -= 1;
                list.insert(source, index);
            } else {
                if (sourceList)
                    sourceList.remove(source);
                if (index < 0)
                    list.append(source);
                else
                    list.insert(source, index);
            }
            source._box = list._box;
            this.refreshPlaceholders();
            this.save();
        },
        dropOnGroup(source, toBox) {
            this.dropOnList(source, lists[toBox], 0);
        },
        forgetRow(row) {
            const list = row.get_parent();
            if (list)
                list.remove(row);
            row.destroy();
            this.refreshPlaceholders();
            this.save();
        },
        reload() {
            BOXES.forEach(box => {
                const list = lists[box];
                rowsOf(list).forEach(row => {
                    list.remove(row);
                    row.destroy();
                });
                list._placeholder = null;
                settings.get_strv(`${box}-box-order`).forEach(item => {
                    const row = new BoxOrderRow(item);
                    row._box = box;
                    row._controller = controller;
                    list.append(row);
                });
            });
            this.refreshPlaceholders();
        },
    };

    BOXES.forEach(box => {
        installListDrop(controller, lists[box]);
    });

    controller.reload();
    return controller;
}

function walkWidgets(widget, fn) {
    fn(widget);
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        walkWidgets(child, fn);
}

function firstScrolled(widget) {
    if (widget instanceof Gtk.ScrolledWindow)
        return widget;
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling()) {
        const found = firstScrolled(child);
        if (found)
            return found;
    }
    return null;
}

// The preferences window already scrolls. Any ScrolledWindow nested inside a
// page is the second bar the user sees; turn those into ordinary expanding
// boxes so only the page moves.
function flattenInnerScrolls(page) {
    const apply = () => {
        const outer = firstScrolled(page);
        walkWidgets(page, widget => {
            if (!(widget instanceof Gtk.ScrolledWindow) || widget === outer)
                return;
            widget.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.NEVER);
            widget.propagate_natural_height = true;
            widget.propagate_natural_width = true;
        });
    };
    page.connect('map', apply);
}

function startEdgeScroll(page) {
    page.connect('realize', () => {
        const scrolled = firstScrolled(page);
        if (!scrolled || scrolled._appindicatorEdgeScroll)
            return;

        scrolled._appindicatorEdgeScroll = true;
        const adj = scrolled.get_vadjustment();
        let step = 0;
        let id = 0;

        const tick = () => {
            adj.set_value(Math.max(adj.lower,
                Math.min(adj.upper - adj.page_size, adj.value + step)));
            return GLib.SOURCE_CONTINUE;
        };

        const motion = new Gtk.DropControllerMotion();
        motion.connect('motion', (_c, _x, y) => {
            const height = scrolled.get_allocated_height();
            if (y <= height * 0.1)
                step = -16;
            else if (y >= height * 0.9)
                step = 16;
            else
                step = 0;

            if (step && !id)
                id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, tick);
            if (!step && id) {
                GLib.source_remove(id);
                id = 0;
            }
        });
        const stop = () => {
            step = 0;
            if (id) {
                GLib.source_remove(id);
                id = 0;
            }
        };
        motion.connect('leave', stop);
        scrolled.add_controller(motion);
        scrolled.connect('destroy', stop);
    });
}

function installPrefsCss() {
    if (installPrefsCss._done)
        return;
    installPrefsCss._done = true;
    const css = new Gtk.CssProvider();
    const data =
        '.appindicator-drop-before { box-shadow: inset 0 2px 0 #3584e4; }' +
        '.appindicator-drop-after { box-shadow: inset 0 -2px 0 #3584e4; }' +
        '.appindicator-box-order-list { min-height: 36px; }';
    try {
        css.load_from_data(data, -1);
    } catch (e) {
        css.load_from_data(new TextEncoder().encode(data));
    }
    Gtk.StyleContext.add_provider_for_display(
        Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
}

function buildGtk4Page(settings) {
    installPrefsCss();
    const page = new Adw.PreferencesPage({
        title: _('Item Order'),
        icon_name: 'view-list-symbolic',
    });

    const lists = {};
    const groups = {};
    BOXES.forEach(box => {
        const group = new Adw.PreferencesGroup({
            title: BOX_TITLES[box],
            description: box === 'left'
                ? _('Simply use drag and drop to order the items any way you want. The tray chip and its icons move as one item.')
                : '',
        });
        const list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
        });
        list.add_css_class('boxed-list');
        list.add_css_class('appindicator-box-order-list');
        list._box = box;
        lists[box] = list;
        groups[box] = group;
        group.add(list);
        page.add(group);
    });

    const controller = bindLists(settings, lists);
    BOXES.forEach(box => {
        const drop = new Gtk.DropTarget({
            actions: Gdk.DragAction.MOVE,
            formats: Gdk.ContentFormats.new_for_gtype(BoxOrderRow),
        });
        drop.connect('drop', (_target, value) => {
            const source = dropRow(value);
            if (!source)
                return false;
            controller.dropOnGroup(source, box);
            return true;
        });
        groups[box].add_controller(drop);
    });
    BOXES.forEach(box => {
        settings.connect(`changed::${box}-box-order`, () => {
            if (!controller._saving)
                controller.reload();
        });
    });

    flattenInnerScrolls(page);
    startEdgeScroll(page);
    return page;
}

function buildGtk3Page(settings) {
    const page = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        margin_start: 24,
        margin_end: 24,
        margin_top: 24,
        margin_bottom: 24,
    });
    const label = new Gtk.Label({
        label: _('Item Order is available in GNOME 42 settings (GTK 4).'),
        wrap: true,
        xalign: 0,
    });
    page.pack_start(label, false, false, 0);
    BOXES.forEach(box => {
        const heading = new Gtk.Label({
            label: BOX_TITLES[box],
            xalign: 0,
        });
        page.pack_start(heading, false, false, 0);
        settings.get_strv(`${box}-box-order`).forEach(item => {
            page.pack_start(new Gtk.Label({
                label: slotLabel(item),
                xalign: 0,
            }), false, false, 0);
        });
    });
    return page;
}

function buildItemOrderPage(settings) {
    if (imports.gi.versions.Gtk === '4.0')
        return buildGtk4Page(settings);
    return buildGtk3Page(settings);
}
