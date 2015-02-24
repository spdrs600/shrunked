let index = 1;
let inputMap = new Map();

addEventListener('change', function(event) {
	if (event.target.localName != 'input' || event.target.type != 'file' || event.target.files.length == 0) {
		return;
	}

	let form = event.target.form;
	if (form) {
		let maxWidth = form.dataset.shrunkedmaxwidth;
		let maxHeight = form.dataset.shrunkedmaxheight;
		if (maxWidth && maxHeight) {
			inputMap.set(index, event.target);
			sendAsyncMessage('Shrunked:Resize', {
				index: index,
				files: event.target.mozGetFileNameArray(),
				maxWidth: parseInt(maxWidth),
				maxHeight: parseInt(maxHeight)
			});
			index++;
			return;
		}
	}

	inputMap.set(index, event.target);
	sendAsyncMessage('Shrunked:PromptAndResize', {
		index: index,
		files: event.target.mozGetFileNameArray()
	});
	index++;
}, true);

addMessageListener('Shrunked:Resized', function(message) {
	console.log(message);

	let replacements = message.data.replacements;
	for (let [k, v] of replacements.entries()) {
		console.log(k, v);
	}

	let inputTag = inputMap.get(message.data.index);
	inputMap.delete(message.data.index);

	let files = inputTag.mozGetFileNameArray();
	inputTag.addEventListener('click', function resetInputTag() {
		inputTag.removeEventListener('click', resetInputTag, true);
		inputTag.mozSetFileNameArray(files);
	}, true);

	let form = inputTag.form;
	if (form) {
		form.dataset.shrunkedmaxwidth = message.data.maxWidth;
		form.dataset.shrunkedmaxheight = message.data.maxHeight;
	}

	let newFiles = files.slice();
	for (let i = 0; i < files.length; i++) {
		if (replacements.has(files[i])) {
			newFiles[i] = replacements.get(files[i]);
		}
	}
	inputTag.mozSetFileNameArray(newFiles);
});
