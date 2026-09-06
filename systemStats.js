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
//
// The /proc parsing follows the Simple System Monitor extension
// <https://github.com/lgiki/gnome-shell-extension-simple-system-monitor>.

/* exported SystemStats */

const ByteArray = imports.byteArray;
const Gio = imports.gi.Gio;

function readProc(path) {
    const [, content] = Gio.File.new_for_path(path).load_contents(null);
    return ByteArray.toString(content).split('\n');
}

// CPU usage is a ratio between two samples, so the reader has to be an object
// that remembers where the previous sample left off.
var SystemStats = class AppIndicatorsSystemStats {
    constructor() {
        this._lastUsed = 0;
        this._lastTotal = 0;
    }

    // Both values are ratios in [0, 1], or null when /proc cannot be read.
    cpuUsage() {
        let used = 0;
        let total = 0;

        try {
            for (const line of readProc('/proc/stat')) {
                const fields = line.trim().split(/\W+/);
                if (fields[0] !== 'cpu' || fields.length < 5)
                    continue;

                const user = Number.parseInt(fields[1]);
                const system = Number.parseInt(fields[3]);
                const idle = Number.parseInt(fields[4]);
                used = user + system;
                total = user + system + idle;
                break;
            }
        } catch (e) {
            return null;
        }

        const usedDelta = used - this._lastUsed;
        const totalDelta = total - this._lastTotal;
        this._lastUsed = used;
        this._lastTotal = total;

        // The first sample has nothing to compare against.
        if (totalDelta <= 0)
            return null;

        return usedDelta / totalDelta;
    }

    memoryUsage() {
        let memTotal = -1;
        let memAvailable = -1;

        try {
            for (const line of readProc('/proc/meminfo')) {
                const fields = line.trim().split(/\W+/);
                if (fields[0] === 'MemTotal')
                    memTotal = Number.parseInt(fields[1]);
                else if (fields[0] === 'MemAvailable')
                    memAvailable = Number.parseInt(fields[1]);

                if (memTotal >= 0 && memAvailable >= 0)
                    break;
            }
        } catch (e) {
            return null;
        }

        if (memTotal <= 0 || memAvailable < 0)
            return null;

        return (memTotal - memAvailable) / memTotal;
    }
};
