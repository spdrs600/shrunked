let EXPORTED_SYMBOLS = ['ExifData'];

Components.utils.import('resource://gre/modules/Promise.jsm');
Components.utils.import('resource://gre/modules/Task.jsm');
Components.utils.import('resource://gre/modules/XPCOMUtils.jsm');

XPCOMUtils.defineLazyModuleGetter(this, 'Shrunked', 'resource://shrunked/shrunked.jsm');

function ExifData() {
}
ExifData.prototype = {
	exif1: null,
	exif2: null,
	gps: null,
	littleEndian: false,

	_getShort: function Exif__getShort(bytes, index=0) {
		if (this.littleEndian) {
			return (bytes[index + 1] << 8) + bytes[index];
		}
		return (bytes[index] << 8) + bytes[index + 1];
	},

	_getInt: function Exif__getInt(bytes, index=0) {
		if (this.littleEndian) {
			return (bytes[index + 3] << 24) + (bytes[index + 2] << 16) + (bytes[index + 1] << 8) + bytes[index];
		}
		return (bytes[index] << 24) + (bytes[index + 1] << 16) + (bytes[index + 2] << 8) + bytes[index + 3];
	},

	_readSection: function Exif__readSection() {
		let fieldLengths = [null, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
		let deferred = Promise.defer();
		Task.spawn((function() {
			try {
				let section = {};
				let array = yield this.readable.read(2);
				let sectionSize = this._getShort(array);
				array = yield this.readable.read(12 * sectionSize);
				for (let i = 0; i < sectionSize; i++) {
					let sub = array.subarray(i * 12, i * 12 + 12);
					let field = {
						code: this._getShort(sub, 0),
						type: this._getShort(sub, 2),
						count: this._getInt(sub, 4),
						value: this._getInt(sub, 8)
					};
					field.size = field.count * fieldLengths[field.type];
					if (field.size > 4) {
						this.readable.setPosition(12 + field.value);
						field.data = yield this.readable.read(field.size);
					}
					section[field.code.toString(16)] = field;
				}
				deferred.resolve(section);
			} catch (ex) {
				deferred.reject(ex);
			}
		}).bind(this));
		return deferred.promise;
	},

	read: function Exif_read(readable) {
		let deferred = Promise.defer();
		Task.spawn((function() {
			try {
				this.readable = readable;
				let array = yield this.readable.read(4);
				if (array[0] != 0xFF || array[1] != 0xD8) {
					throw('Not a JPEG');
				}
				if (array[2] != 0xFF || array[3] != 0xE1) {
					throw('No valid EXIF data');
				}
				array = yield this.readable.read(16);
				if (array[8] == 0x49 && array[9] == 0x49) {
					this.littleEndian = true;
				} else if (array[8] != 0x4D || array[9] != 0x4D) {
					throw('Invalid bytes');
				}

				this.exif1 = yield this._readSection();

				yield this.readable.setPosition(12 + this.exif1['8769'].value);
				this.exif2 = yield this._readSection();

				yield this.readable.setPosition(12 + this.exif1['8825'].value);
				this.gps = yield this._readSection();

				let blacklist = JSON.parse(Shrunked.prefs.getCharPref('exif.blacklist'));
				for (let key of blacklist) {
					delete this.exif1[key];
					delete this.exif2[key];
				}

				deferred.resolve();
			} catch (ex) {
				deferred.reject(ex);
			} finally {
				this.readable.close();
			}
		}).bind(this));
		return deferred.promise;
	},

	get orientation() {
		if (this.exif1 && '112' in this.exif1) {
			switch (this.exif1['112'].value) {
			case 8:
				return 90;
			case 3:
				return 180;
			case 6:
				return 270;
			}
		}
		return 0;
	},

	_countSection: function Exif__countSection(section) {
		if (!section) {
			return [0, 0];
		}

		let count = 0;
		let size = 6;
		for (let [, e] of Iterator(section)) {
			count++;
			size += 12;
			if (e.size > 4) {
				size += e.size;
			}
		}
		return [count, size];
	},

	_get2Bytes: function Exif__get2Bytes(short) {
		let bytes = [
			(short & 0xFF00) >> 8,
			(short & 0x00FF)
		];
		if (this.littleEndian) {
			bytes.reverse();
		}
		return bytes;
	},

	_get4Bytes: function Exif__get4Bytes(int) {
		let bytes = [
			(int & 0xFF000000) >> 24,
			(int & 0x00FF0000) >> 16,
			(int & 0x0000FF00) >> 8,
			(int & 0x000000FF)
		];
		if (this.littleEndian) {
			bytes.reverse();
		}
		return bytes;
	},

	_writeSection: function Exif__writeSection(section, buffer, index, count) {
		buffer.set(this._get2Bytes(count), index);

		index += 2;
		let dataindex = index + 4 + 12 * count;
		for (let [, e] of Iterator(section)) {
			let sub = [];
			sub = sub.concat(this._get2Bytes(e.code));
			sub = sub.concat(this._get2Bytes(e.type));
			sub = sub.concat(this._get4Bytes(e.count));
			if (e.size <= 4) {
				sub = sub.concat(this._get4Bytes(e.value));
			} else {
				sub = sub.concat(this._get4Bytes(dataindex - 12));
				buffer.set(e.data, dataindex);
				dataindex += e.size;
			}
			buffer.set(sub, index);
			index += 12;
		}
		return dataindex;
	},

	write: function Exif_write(file) {
		let deferred = Promise.defer();
		Task.spawn((function() {
			try {
				let [e1count, e1size] = this._countSection(this.exif1);
				let [e2count, e2size] = this._countSection(this.exif2);
				this.exif1['8769'].value = 8 + e1size;

				let [gpscount, gpssize] = this._countSection(this.gps);
				if (Shrunked.options.gps && this.gps) {
					this.exif1['8825'].value = 8 + e1size + e2size;
				} else {
					delete this.exif1['8825'];
					gpssize = 0;
				}

				let buffer = new Uint8Array(20 + e1size + e2size + gpssize);
				buffer.set([0xFF, 0xD8, 0xFF, 0xE1]);
				buffer[4] = ((buffer.length - 4) & 0xFF00) >> 8;
				buffer[5] = (buffer.length - 4) & 0x00FF;
				buffer.set([0x45, 0x78, 0x69, 0x66], 6);
				if (this.littleEndian) {
					buffer.set([0x49, 0x49], 12);
				} else {
					buffer.set([0x4D, 0x4D], 12);
				}
				buffer.set(this._get2Bytes(0x2A), 14);
				buffer.set(this._get4Bytes(0x08), 16);

				let index = 20;
				index = this._writeSection(this.exif1, buffer, index, e1count);
				index = this._writeSection(this.exif2, buffer, index, e2count);
				if (Shrunked.options.gps && this.gps) {
					this._writeSection(this.gps, buffer, index, gpscount);
				}

				yield file.write(buffer);
				deferred.resolve();
			} catch (ex) {
				deferred.reject(ex);
			}
		}).bind(this));
		return deferred.promise;
	}
};