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

/* exported buildBackupGroup, attachBackupButtons */

const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Gtk = imports.gi.Gtk;
const Adw = imports.gi.Adw;

const ExtensionUtils = imports.misc.extensionUtils;
const Me = ExtensionUtils.getCurrentExtension();
const Gettext = imports.gettext.domain(
    Me ? Me.metadata['gettext-domain'] : 'AppIndicatorExtension');
const _ = Gettext.gettext;

const FORMAT = 1;
const UUID = 'appindicator-overflow@tiiehenry.github.io';
const SCHEMA = 'org.gnome.shell.extensions.appindicator-overflow';

function schemaId(settings) {
    if (settings.settings_schema)
        return settings.settings_schema.get_id();
    return SCHEMA;
}

function dumpSettings(settings) {
    const values = {};
    settings.list_keys().forEach(key => {
        values[key] = settings.get_value(key).deep_unpack();
    });
    return {
        format: FORMAT,
        uuid: Me ? Me.metadata.uuid : UUID,
        schema: schemaId(settings),
        settings: values,
    };
}

function normalizeValue(typeStr, value) {
    switch (typeStr) {
    case 'b':
        if (typeof value === 'boolean')
            return value;
        break;
    case 'i':
        if (typeof value === 'number' && Number.isFinite(value))
            return Math.round(value);
        break;
    case 'd':
        if (typeof value === 'number' && Number.isFinite(value))
            return value;
        break;
    case 's':
        if (typeof value === 'string')
            return value;
        break;
    case 'as':
        if (Array.isArray(value) && value.every(item => typeof item === 'string'))
            return value;
        break;
    case 'a(ss)':
        if (Array.isArray(value)) {
            return value.map(pair => {
                if (!Array.isArray(pair) || pair.length < 2)
                    throw new Error(typeStr);
                return [String(pair[0]), String(pair[1])];
            });
        }
        break;
    case 'a(sss)':
        if (Array.isArray(value)) {
            return value.map(triple => {
                if (!Array.isArray(triple) || triple.length < 2)
                    throw new Error(typeStr);
                return [String(triple[0]), String(triple[1]), String(triple[2] || '')];
            });
        }
        break;
    default:
        break;
    }
    throw new Error(typeStr);
}

function coerceVariant(typeStr, value) {
    if (typeof value === 'string' && typeStr !== 's') {
        try {
            return GLib.Variant.parse(new GLib.VariantType(typeStr), value, null, null);
        } catch (e) {
        }
    }
    return new GLib.Variant(typeStr, normalizeValue(typeStr, value));
}

function parseBackup(text) {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('invalid');

    const values = data.settings && typeof data.settings === 'object' &&
        !Array.isArray(data.settings)
        ? data.settings
        : data;

    if (data.schema && data.schema !== SCHEMA)
        throw new Error('schema');
    if (data.uuid && data.uuid !== UUID)
        throw new Error('uuid');
    if (data.format !== undefined && data.format !== FORMAT)
        throw new Error('format');

    return values;
}

function applySettings(settings, values) {
    const schema = settings.settings_schema;
    let applied = 0;
    const skipped = [];

    settings.delay();
    try {
        Object.keys(values).forEach(key => {
            if (!schema.has_key(key)) {
                skipped.push(key);
                return;
            }
            try {
                const typeStr = schema.get_key(key).get_value_type().dup_string();
                const variant = coerceVariant(typeStr, values[key]);
                if (!settings.get_value(key).equal(variant))
                    settings.set_value(key, variant);
                applied++;
            } catch (e) {
                skipped.push(key);
            }
        });
        if (schema.has_key('box-order-migrated') &&
            !Object.prototype.hasOwnProperty.call(values, 'box-order-migrated') &&
            ['left-box-order', 'center-box-order', 'right-box-order']
                .some(key => Object.prototype.hasOwnProperty.call(values, key)))
            settings.set_boolean('box-order-migrated', true);
    } finally {
        settings.apply();
    }

    if (!applied)
        throw new Error('empty');
    return { applied, skipped };
}

function fileText(bytes) {
    if (bytes instanceof Uint8Array)
        return new TextDecoder('utf-8').decode(bytes);
    return imports.byteArray.toString(bytes);
}

function writeJson(file, payload) {
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    const bytes = new TextEncoder().encode(text);
    file.replace_contents(bytes, null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
}

function readJson(file) {
    const [, contents] = file.load_contents(null);
    return fileText(contents);
}

function parentWindow(widget) {
    if (!widget)
        return null;
    if (widget.get_root)
        return widget.get_root();
    if (widget.get_toplevel)
        return widget.get_toplevel();
    return null;
}

function toast(window, title) {
    if (window && window.add_toast) {
        window.add_toast(new Adw.Toast({ title, timeout: 4 }));
        return;
    }
    if (!window)
        return;
    const dialog = new Gtk.MessageDialog({
        transient_for: window,
        modal: true,
        text: title,
        buttons: Gtk.ButtonsType.OK,
    });
    dialog.connect('response', () => dialog.destroy());
    dialog.show();
}

function defaultName() {
    const name = Me && Me.metadata && Me.metadata.name
        ? String(Me.metadata.name)
        : 'AppIndicator';
    const safe = name.replace(/[/\\?%*:|"<>]/g, '').trim() || 'AppIndicator';
    return `${safe}.json`;
}

function addJsonFilter(dialog) {
    const jsonFilter = new Gtk.FileFilter();
    jsonFilter.set_name(_('JSON files'));
    jsonFilter.add_pattern('*.json');
    jsonFilter.add_mime_type('application/json');
    dialog.add_filter(jsonFilter);

    const allFilter = new Gtk.FileFilter();
    allFilter.set_name(_('All files'));
    allFilter.add_pattern('*');
    dialog.add_filter(allFilter);
}

function chooseFile(parent, action, title, name, onAccept) {
    const dialog = new Gtk.FileChooserNative({
        title,
        action,
        transient_for: parent,
        modal: true,
    });
    addJsonFilter(dialog);
    if (action === Gtk.FileChooserAction.SAVE && name)
        dialog.set_current_name(name);

    const downloads = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD);
    if (downloads) {
        try {
            dialog.set_current_folder(Gio.File.new_for_path(downloads));
        } catch (e) {
        }
    }

    dialog.connect('response', (dlg, response) => {
        try {
            if (response === Gtk.ResponseType.ACCEPT) {
                let file = dlg.get_file();
                if (file && action === Gtk.FileChooserAction.SAVE) {
                    const path = file.get_path();
                    if (path && !path.toLowerCase().endsWith('.json'))
                        file = Gio.File.new_for_path(`${path}.json`);
                }
                if (file)
                    onAccept(file);
            }
        } finally {
            dlg.destroy();
        }
    });
    dialog.show();
}

function exportSettings(settings, window) {
    chooseFile(window, Gtk.FileChooserAction.SAVE,
        _('Export configuration'), defaultName(), file => {
            try {
                writeJson(file, dumpSettings(settings));
                toast(window, _('Configuration exported'));
            } catch (e) {
                toast(window, _('Could not export configuration'));
            }
        });
}

function importSettings(settings, window) {
    chooseFile(window, Gtk.FileChooserAction.OPEN,
        _('Import configuration'), null, file => {
            try {
                applySettings(settings, parseBackup(readJson(file)));
                toast(window,
                    _('Configuration imported. Reopen this window to refresh the pages.'));
            } catch (e) {
                const key = e && e.message;
                if (key === 'schema' || key === 'uuid' || key === 'format' ||
                    key === 'invalid')
                    toast(window, _('This file is not an AppIndicator backup'));
                else
                    toast(window, _('Could not import configuration'));
            }
        });
}

function addButton(box, label, onClick) {
    const button = new Gtk.Button({ label, valign: Gtk.Align.CENTER });
    button.connect('clicked', onClick);
    if (box.append)
        box.append(button);
    else
        box.pack_start(button, false, false, 0);
}

function attachBackupButtons(box, settings) {
    const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 10,
        margin_start: 10,
        margin_end: 10,
        margin_top: 10,
        margin_bottom: 10,
    });
    const label = new Gtk.Label({
        label: _('Backup'),
        hexpand: true,
        halign: Gtk.Align.START,
    });
    if (row.append)
        row.append(label);
    else
        row.pack_start(label, true, true, 0);

    addButton(row, _('Export'), () => {
        exportSettings(settings, parentWindow(box));
    });
    addButton(row, _('Import'), () => {
        importSettings(settings, parentWindow(box));
    });

    if (box.append)
        box.append(row);
    else
        box.pack_start(row, true, false, 0);
}

function actionRow(title, subtitle, iconName, buttonLabel, onClick) {
    const row = new Adw.ActionRow({
        title,
        subtitle,
        icon_name: iconName,
        activatable: true,
    });
    const button = new Gtk.Button({
        label: buttonLabel,
        valign: Gtk.Align.CENTER,
    });
    button.connect('clicked', onClick);
    row.add_suffix(button);
    row.connect('activated', onClick);
    return row;
}

function buildBackupGroup(settings, window) {
    const group = new Adw.PreferencesGroup({
        title: _('Backup'),
        description: _('Save or restore every setting in this extension.'),
    });
    group.add(actionRow(
        _('Export configuration'),
        _('Save all settings to a JSON file'),
        'document-save-symbolic',
        _('Export'),
        () => exportSettings(settings, window)));
    group.add(actionRow(
        _('Import configuration'),
        _('Replace current settings from a JSON file'),
        'document-open-symbolic',
        _('Import'),
        () => importSettings(settings, window)));
    return group;
}
