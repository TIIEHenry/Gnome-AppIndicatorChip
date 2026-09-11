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

/* exported BaseStatusIcon, IndicatorStatusIcon, IndicatorStatusTrayIcon,
            addIconToPanel, addIconToPanelRole, removeIconFromPanel, panelActor,
            getTrayIcons, getAppIndicatorIcons */

const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GObject = imports.gi.GObject;
const St = imports.gi.St;

const AppDisplay = imports.ui.appDisplay;
const Main = imports.ui.main;
const Panel = imports.ui.panel;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;

const ExtensionUtils = imports.misc.extensionUtils;
const Extension = ExtensionUtils.getCurrentExtension();

const AppIndicator = Extension.imports.appIndicator;
const DBusMenu = Extension.imports.dbusMenu;
const Util = Extension.imports.util;
const PromiseUtils = Extension.imports.promiseUtils;
const SettingsManager = Extension.imports.settingsManager;

const _ = imports.gettext.domain(Extension.metadata['gettext-domain']).gettext;

// Up to GNOME 44 a PanelMenu.Button wraps itself into a bin, and it is that
// bin, not the button, that the panel keeps in its boxes. Anything moving an
// icon around the scene graph has to move the wrapper along with it.
function panelActor(button) {
    return button.container || button;
}

function addIconToPanelRole(button, role) {
    const settings = SettingsManager.getDefaultGSettings();
    const currentIcon = Main.panel.statusArea[role];
    if (currentIcon) {
        if (currentIcon !== button)
            currentIcon.destroy();
        delete Main.panel.statusArea[role];
    }

    Main.panel.addToStatusArea(role, button, 1, settings.get_string('tray-pos'));
}

function addIconToPanel(statusIcon) {
    if (!(statusIcon instanceof BaseStatusIcon))
        throw TypeError(`Unexpected icon type: ${statusIcon}`);

    addIconToPanelRole(statusIcon, `appindicator-${statusIcon.uniqueId}`);

    if (statusIcon._updateSpacing)
        statusIcon._updateSpacing();

    if (statusIcon._trayPosChangedIds)
        return;

    const settings = SettingsManager.getDefaultGSettings();
    statusIcon._trayPosChangedIds = Util.connectSmart(settings, 'changed::tray-pos',
        statusIcon, () => addIconToPanel(statusIcon));
}

function removeIconFromPanel(statusIcon) {
    const role = `appindicator-${statusIcon.uniqueId}`;
    if (Main.panel.statusArea[role] !== statusIcon)
        return;

    if (statusIcon.menu && Main.panel.menuManager)
        Main.panel.menuManager.removeMenu(statusIcon.menu);

    const actor = panelActor(statusIcon);
    const parent = actor.get_parent();
    if (parent)
        parent.remove_child(actor);

    delete Main.panel.statusArea[role];
}

function getTrayIcons() {
    return Object.values(Main.panel.statusArea).filter(
        i => i instanceof IndicatorStatusTrayIcon);
}

function getAppIndicatorIcons() {
    return Object.values(Main.panel.statusArea).filter(
        i => i instanceof IndicatorStatusIcon);
}

var BaseStatusIcon = GObject.registerClass(
class AppIndicatorsIndicatorBaseStatusIcon extends PanelMenu.Button {
    _init(menuAlignment, nameText, iconActor, dontCreateMenu) {
        super._init(menuAlignment, nameText, dontCreateMenu);

        this.add_style_class_name('appindicator-button');
        this._hpad = 0;

        const settings = SettingsManager.getDefaultGSettings();
        Util.connectSmart(settings, 'changed::icon-opacity', this, this._updateOpacity);
        Util.connectSmart(settings, 'changed::icon-spacing', this, this._updateSpacing);
        this.connect('notify::hover', () => this._onHoverChanged());
        // The highlight is drawn by the box around the icon rather than by the
        // whole button, so the pressed state has to reach it as well.
        const setPressed = pressed => {
            const apply = actor => {
                if (pressed)
                    actor.add_style_pseudo_class('active');
                else
                    actor.remove_style_pseudo_class('active');
            };
            apply(this);
            if (this._box)
                apply(this._box);
        };

        this.connect('button-press-event', () => {
            setPressed(true);
            return Clutter.EVENT_PROPAGATE;
        });
        // Opening the menu grabs the pointer, which arrives here as a leave
        // event; dropping the highlight then would hide that the menu of this
        // very icon is the one on screen.
        const clearPressed = () => {
            if (!this.menu || !this.menu.isOpen)
                setPressed(false);
            return Clutter.EVENT_PROPAGATE;
        };
        this.connect('button-release-event', clearPressed);
        this.connect('leave-event', clearPressed);
        if (this.menu) {
            this.menu.connect('open-state-changed',
                (_menu, open) => setPressed(open));
        }

        if (!super._onDestroy)
            this.connect('destroy', () => this._onDestroy());

        this._box = new St.BoxLayout({
            style_class: 'panel-status-indicators-box appindicator-icon-box',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._box);

        this._setIconActor(iconActor);
        this._updateSpacing();
        this._showIfReady();
    }

    _updateSpacing() {
        const settings = SettingsManager.getDefaultGSettings();
        this._hpad = Math.max(0, settings.get_int('icon-spacing'));
        this.set_style(
            `-natural-hpadding: ${this._hpad}px; ` +
            `-minimum-hpadding: ${this._hpad}px;`);
        this.queue_relayout();
    }

    _setIconActor(icon) {
        if (!(icon instanceof Clutter.Actor))
            throw new Error(`${icon} is not a valid actor`);

        if (this._icon && this._icon !== icon) {
            if (this._iconDestroyId) {
                try {
                    this._icon.disconnect(this._iconDestroyId);
                } catch (e) {}
                this._iconDestroyId = 0;
            }
            this._icon.destroy();
        }

        this._icon = icon;
        this._updateEffects();
        this._monitorIconEffects();

        if (this._icon) {
            this._icon.set({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._box.add_child(this._icon);
            this._iconDestroyId = this._icon.connect('destroy', () => {
                this._iconDestroyId = 0;
                this._icon = null;
                this._monitorIconEffects();
            });
        }
    }

    _onDestroy() {
        if (this._icon) {
            if (this._iconDestroyId) {
                try {
                    this._icon.disconnect(this._iconDestroyId);
                } catch (e) {}
                this._iconDestroyId = 0;
            }
            this._icon.destroy();
            this._icon = null;
        }

        if (super._onDestroy)
            super._onDestroy();
    }

    // Sizes are given in CSS pixels; pass null to go back to the panel size.
    setForcedIconSize(iconSize) {
        this._forcedIconSize = iconSize;

        if (this._icon && this._icon.setForcedIconSize)
            this._icon.setForcedIconSize(iconSize);
        else if (this._updateIconSize)
            this._updateIconSize();
    }

    isReady() {
        throw new GObject.NotImplementedError('isReady() in %s'.format(this.constructor.name));
    }

    get icon() {
        return this._icon;
    }

    get uniqueId() {
        throw new GObject.NotImplementedError('uniqueId in %s'.format(this.constructor.name));
    }

    _showIfReady() {
        this.visible = this.isReady();
    }

    _onHoverChanged() {
        if (this.hover) {
            this.opacity = 255;
            if (this._icon)
                this._icon.remove_effect_by_name('desaturate');
        } else {
            this._updateEffects();
        }
    }

    _updateOpacity() {
        const settings = SettingsManager.getDefaultGSettings();
        const userValue = settings.get_user_value('icon-opacity');
        if (userValue)
            this.opacity = userValue.unpack();
        else if (Util.versionCheck(['40']))
            this.opacity = 255;
        else
            this.opacity = settings.get_int('icon-opacity');
    }

    _updateEffects() {
        this._updateOpacity();

        if (this._icon) {
            this._updateSaturation();
            this._updateBrightnessContrast();
        }
    }

    _monitorIconEffects() {
        const settings = SettingsManager.getDefaultGSettings();
        const monitoring = !!this._iconSaturationIds;

        if (!this._icon && monitoring) {
            Util.disconnectSmart(settings, this, this._iconSaturationIds);
            delete this._iconSaturationIds;

            Util.disconnectSmart(settings, this, this._iconBrightnessIds);
            delete this._iconBrightnessIds;

            Util.disconnectSmart(settings, this, this._iconContrastIds);
            delete this._iconContrastIds;
        } else if (this._icon && !monitoring) {
            this._iconSaturationIds =
                Util.connectSmart(settings, 'changed::icon-saturation', this,
                    this._updateSaturation);
            this._iconBrightnessIds =
                Util.connectSmart(settings, 'changed::icon-brightness', this,
                    this._updateBrightnessContrast);
            this._iconContrastIds =
                Util.connectSmart(settings, 'changed::icon-contrast', this,
                    this._updateBrightnessContrast);
        }
    }

    _updateSaturation() {
        const settings = SettingsManager.getDefaultGSettings();
        const desaturationValue = settings.get_double('icon-saturation');
        let desaturateEffect = this._icon.get_effect('desaturate');

        if (desaturationValue > 0) {
            if (!desaturateEffect) {
                desaturateEffect = new Clutter.DesaturateEffect();
                this._icon.add_effect_with_name('desaturate', desaturateEffect);
            }
            desaturateEffect.set_factor(desaturationValue);
        } else if (desaturateEffect) {
            this._icon.remove_effect(desaturateEffect);
        }
    }

    _updateBrightnessContrast() {
        const settings = SettingsManager.getDefaultGSettings();
        const brightnessValue = settings.get_double('icon-brightness');
        const contrastValue = settings.get_double('icon-contrast');
        let brightnessContrastEffect = this._icon.get_effect('brightness-contrast');

        if (brightnessValue !== 0 | contrastValue !== 0) {
            if (!brightnessContrastEffect) {
                brightnessContrastEffect = new Clutter.BrightnessContrastEffect();
                this._icon.add_effect_with_name('brightness-contrast', brightnessContrastEffect);
            }
            brightnessContrastEffect.set_brightness(brightnessValue);
            brightnessContrastEffect.set_contrast(contrastValue);
        } else if (brightnessContrastEffect) {
            this._icon.remove_effect(brightnessContrastEffect);
        }
    }
});

/*
 * IndicatorStatusIcon implements an icon in the system status area
 */
var IndicatorStatusIcon = GObject.registerClass(
class AppIndicatorsIndicatorStatusIcon extends BaseStatusIcon {
    _init(indicator) {
        super._init(0.5, indicator.accessibleName,
            new AppIndicator.IconActor(indicator, Panel.PANEL_ICON_SIZE));
        this._indicator = indicator;

        this._lastClickTime = -1;
        this._lastClickX = -1;
        this._lastClickY = -1;

        this._box.add_style_class_name('appindicator-box');

        Util.connectSmart(this._indicator, 'ready', this, this._showIfReady);
        Util.connectSmart(this._indicator, 'menu', this, this._updateMenu);
        // The optional SNI text label is deliberately not shown, so that every
        // tray item keeps the same width.
        Util.connectSmart(this._indicator, 'status', this, this._updateStatus);
        Util.connectSmart(this._indicator, 'reset', this, this._updateStatus);
        Util.connectSmart(this._indicator, 'accessible-name', this, () =>
            this.set_accessible_name(this._indicator.accessibleName));
        Util.connectSmart(this._indicator, 'destroy', this, () => this.destroy());

        this.connect('notify::visible', () => this._updateMenu());

        this._showIfReady();
    }

    _onDestroy() {
        if (this._menuClient) {
            this._menuClient.disconnect(this._menuReadyId);
            this._menuClient.destroy();
            this._menuClient = null;
        }

        super._onDestroy();
    }

    get uniqueId() {
        return this._indicator.uniqueId;
    }

    isReady() {
        return this._indicator && this._indicator.isReady;
    }

    _updateStatus() {
        const wasVisible = this.visible;
        this.visible = this._indicator.status !== AppIndicator.SNIStatus.PASSIVE;

        if (this.visible !== wasVisible)
            this._indicator.checkAlive().catch(logError);
    }

    _updateMenu() {
        if (this._menuClient) {
            this._menuClient.disconnect(this._menuReadyId);
            this._menuClient.destroy();
            this._menuClient = null;
            this.menu.removeAll();
        }

        if (this.visible && this._indicator.menuPath) {
            this._menuClient = new DBusMenu.Client(this._indicator.busName,
                this._indicator.menuPath, this._indicator);

            if (this._menuClient.isReady)
                this._menuClient.attachToMenu(this.menu);

            this._menuReadyId = this._menuClient.connect('ready-changed', () => {
                if (this._menuClient.isReady)
                    this._menuClient.attachToMenu(this.menu);
                else
                    this._updateMenu();
                this._appendOverflowMenuItems();
            });
        }

        this._appendOverflowMenuItems();
    }

    async prepareMenuOpen() {
        if (this._menuClient)
            await this._menuClient.prepareOpen();
        this._appendOverflowMenuItems();
    }

    _toggleMenu() {
        if (!this.menu)
            return;
        if (this._menuClient && !this.menu.isOpen)
            this._menuClient.flushPendingItems();
        this.menu.toggle();
    }

    _clearOverflowMenuItems() {
        const items = this._overflowMenuItems || [];
        this._overflowMenuItems = [];
        items.forEach(item => {
            try {
                if (item && !item._destroyed && item.destroy)
                    item.destroy();
            } catch (e) {}
        });
    }

    _appendOverflowMenuItems() {
        this._clearOverflowMenuItems();
        const manager = Extension.imports.overflowManager.OverflowManager.peek();
        if (!manager)
            return;

        const sep = new PopupMenu.PopupSeparatorMenuItem();
        const action = manager.isHidden(this)
            ? new PopupMenu.PopupMenuItem(_('Show on the panel'))
            : new PopupMenu.PopupMenuItem(_('Move into the overflow'));
        action.connect('activate', () => {
            if (manager.isHidden(this))
                manager.pin(this);
            else
                manager.hide(this);
        });
        this.menu.addMenuItem(sep);
        this.menu.addMenuItem(action);

        this._overflowMenuItems = [sep, action];
    }

    _showIfReady() {
        if (!this.isReady())
            return;

        this._updateStatus();
        this._updateMenu();
    }

    _updateClickCount(buttonEvent) {
        const { x, y, time } = buttonEvent;
        const { doubleClickDistance, doubleClickTime } =
            Clutter.Settings.get_default();

        if (time > (this._lastClickTime + doubleClickTime) ||
            (Math.abs(x - this._lastClickX) > doubleClickDistance) ||
            (Math.abs(y - this._lastClickY) > doubleClickDistance))
            this._clickCount = 0;

        this._lastClickTime = time;
        this._lastClickX = x;
        this._lastClickY = y;

        this._clickCount = (this._clickCount % 2) + 1;

        return this._clickCount;
    }

    _maybeHandleDoubleClick(buttonEvent) {
        if (this._indicator.supportsActivation === false)
            return Clutter.EVENT_PROPAGATE;

        if (buttonEvent.button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        if (buttonEvent.click_count === 2 ||
            (buttonEvent.click_count === undefined &&
             this._updateClickCount(buttonEvent) === 2)) {
            this._indicator.open(buttonEvent.x, buttonEvent.y, buttonEvent.time);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    async _waitForDoubleClick() {
        const { doubleClickTime } = Clutter.Settings.get_default();
        this._waitDoubleClickPromise = new PromiseUtils.TimeoutPromise(
            doubleClickTime);

        try {
            await this._waitDoubleClickPromise;
            this._toggleMenu();
        } catch (e) {
            if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                throw e;
        } finally {
            delete this._waitDoubleClickPromise;
        }
    }

    vfunc_event(event) {
        if (this.menu.numMenuItems && event.type() === Clutter.EventType.TOUCH_BEGIN)
            this._toggleMenu();

        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_press_event(buttonEvent) {
        if (this._waitDoubleClickPromise)
            this._waitDoubleClickPromise.cancel();

        // Inside the overflow the menu opens on release, so that the icon has
        // a chance to show that it is being pressed.
        const overflow = Extension.imports.overflowManager.OverflowManager.peek();
        if (overflow && overflow.isOverflowSource(this) &&
            buttonEvent.button !== Clutter.BUTTON_MIDDLE)
            return Clutter.EVENT_STOP;

        // if middle mouse button clicked send SecondaryActivate dbus event and do not show appindicator menu
        if (buttonEvent.button === Clutter.BUTTON_MIDDLE) {
            if (Main.panel.menuManager.activeMenu)
                Main.panel.menuManager._closeMenu(true, Main.panel.menuManager.activeMenu);
            this._indicator.secondaryActivate(buttonEvent.time, buttonEvent.x, buttonEvent.y);
            return Clutter.EVENT_STOP;
        }

        if (buttonEvent.button === Clutter.BUTTON_SECONDARY) {
            this._toggleMenu();
            return Clutter.EVENT_PROPAGATE;
        }

        const doubleClickHandled = this._maybeHandleDoubleClick(buttonEvent);
        if (doubleClickHandled === Clutter.EVENT_PROPAGATE &&
            buttonEvent.button === Clutter.BUTTON_PRIMARY &&
            this.menu.numMenuItems) {
            if (this._indicator.supportsActivation)
                this._waitForDoubleClick().catch(logError);
            else
                this._toggleMenu();
        }

        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_button_release_event(buttonEvent) {
        const overflow = Extension.imports.overflowManager.OverflowManager.peek();
        if (overflow && overflow.isOverflowSource(this) &&
            buttonEvent.button !== Clutter.BUTTON_MIDDLE) {
            overflow.openIconMenu(this);
            return Clutter.EVENT_STOP;
        }

        if (!this._indicator.supportsActivation)
            return this._maybeHandleDoubleClick(buttonEvent);

        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_scroll_event(scrollEvent) {
        // Since Clutter 1.10, clutter will always send a smooth scrolling event
        // with explicit deltas, no matter what input device is used
        // In fact, for every scroll there will be a smooth and non-smooth scroll
        // event, and we can choose which one we interpret.
        if (scrollEvent.direction === Clutter.ScrollDirection.SMOOTH) {
            const event = Clutter.get_current_event();
            let [dx, dy] = event.get_scroll_delta();

            this._indicator.scroll(dx, dy);
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }
});

var IndicatorStatusTrayIcon = GObject.registerClass(
class AppIndicatorsIndicatorTrayIcon extends BaseStatusIcon {
    _init(icon) {
        super._init(0.5, icon.wm_class, icon, { dontCreateMenu: true });
        Util.Logger.debug(`Adding legacy tray icon ${this.uniqueId}`);
        this._box.add_style_class_name('appindicator-trayicons-box');
        this.add_style_class_name('appindicator-icon');
        this.add_style_class_name('tray-icon');

        this.connect('button-press-event', () => {
            this.add_style_pseudo_class('active');
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('button-release-event', (_actor, event) => {
            this._icon.click(event);
            this.remove_style_pseudo_class('active');
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('key-press-event', (_actor, event) => {
            this.add_style_pseudo_class('active');
            this._icon.click(event);
            return Clutter.EVENT_PROPAGATE;
        });
        this.connect('key-release-event', (_actor, event) => {
            this._icon.click(event);
            this.remove_style_pseudo_class('active');
            return Clutter.EVENT_PROPAGATE;
        });

        Util.connectSmart(this._icon, 'destroy', this, () => {
            icon.clear_effects();
            this.destroy();
        });

        const settings = SettingsManager.getDefaultGSettings();
        Util.connectSmart(settings, 'changed::icon-size', this, this._updateIconSize);

        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        Util.connectSmart(themeContext, 'notify::scale-factor', this, () =>
            this._updateIconSize());

        this._updateIconSize();
    }

    _onDestroy() {
        Util.Logger.debug(`Destroying legacy tray icon ${this.uniqueId}`);

        if (this._waitDoubleClickPromise)
            this._waitDoubleClickPromise.cancel();

        super._onDestroy();
    }

    isReady() {
        return !!this._icon;
    }

    get uniqueId() {
        return `legacy:${this._icon.wm_class}:${this._icon.pid}`;
    }

    vfunc_navigate_focus(from, direction) {
        this.grab_key_focus();
        return super.vfunc_navigate_focus(from, direction);
    }

    _getSimulatedButtonEvent(touchEvent) {
        const event = Clutter.Event.new(Clutter.EventType.BUTTON_RELEASE);
        event.set_button(1);
        event.set_time(touchEvent.time);
        event.set_flags(touchEvent.flags);
        event.set_stage(touchEvent.stage);
        event.set_source(touchEvent.source);
        event.set_coords(touchEvent.x, touchEvent.y);
        event.set_state(touchEvent.modifier_state);
        return event;
    }

    vfunc_touch_event(touchEvent) {
        // Under X11 we rely on emulated pointer events
        if (!imports.gi.Meta.is_wayland_compositor())
            return Clutter.EVENT_PROPAGATE;

        const slot = touchEvent.sequence.get_slot();

        if (!this._touchPressSlot &&
            touchEvent.type === Clutter.EventType.TOUCH_BEGIN) {
            this.add_style_pseudo_class('active');
            this._touchButtonEvent = this._getSimulatedButtonEvent(touchEvent);
            this._touchPressSlot = slot;
            this._touchDelayPromise = new PromiseUtils.TimeoutPromise(
                AppDisplay.MENU_POPUP_TIMEOUT);
            this._touchDelayPromise.then(() => {
                delete this._touchDelayPromise;
                delete this._touchPressSlot;
                this._touchButtonEvent.set_button(3);
                this._icon.click(this._touchButtonEvent);
                this.remove_style_pseudo_class('active');
            });
        } else if (touchEvent.type === Clutter.EventType.TOUCH_END &&
                   this._touchPressSlot === slot) {
            delete this._touchPressSlot;
            delete this._touchButtonEvent;
            if (this._touchDelayPromise) {
                this._touchDelayPromise.cancel();
                delete this._touchDelayPromise;
            }

            this._icon.click(this._getSimulatedButtonEvent(touchEvent));
            this.remove_style_pseudo_class('active');
        } else if (touchEvent.type === Clutter.EventType.TOUCH_UPDATE &&
                   this._touchPressSlot === slot) {
            this.add_style_pseudo_class('active');
            this._touchButtonEvent = this._getSimulatedButtonEvent(touchEvent);
        }

        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_leave_event(crossingEvent) {
        this.remove_style_pseudo_class('active');

        if (this._touchDelayPromise) {
            this._touchDelayPromise.cancel();
            delete this._touchDelayPromise;
        }

        return super.vfunc_leave_event(crossingEvent);
    }

    _updateIconSize() {
        const settings = SettingsManager.getDefaultGSettings();
        const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
        let iconSize = this._forcedIconSize || settings.get_int('icon-size');

        if (iconSize <= 0)
            iconSize = Panel.PANEL_ICON_SIZE;

        this.height = -1;
        this._icon.set({
            width: iconSize * scaleFactor,
            height: iconSize * scaleFactor,
            xAlign: Clutter.ActorAlign.CENTER,
            yAlign: Clutter.ActorAlign.CENTER,
        });
    }
});
