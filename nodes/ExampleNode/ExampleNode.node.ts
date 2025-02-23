import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionType, NodeOperationError } from 'n8n-workflow';

import { KokoroTTS } from 'kokoro-js';
import wavefile from 'wavefile';

// Helper: Concatenate multiple Float32Arrays into one.
function concatFloat32Arrays(arrays: Float32Array[]): Float32Array {
	const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
	const result = new Float32Array(totalLength);
	let offset = 0;
	arrays.forEach((arr) => {
		result.set(arr, offset);
		offset += arr.length;
	});
	return result;
}

// Helper: Convert Float32 samples (range -1 to 1) to Int16 samples.
function float32ToInt16(buffer: Float32Array): Int16Array {
	const l = buffer.length;
	const result = new Int16Array(l);
	for (let i = 0; i < l; i++) {
		// Clamp the value between -1 and 1 and scale to int16 range.
		let s = Math.max(-1, Math.min(1, buffer[i]));
		result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
	}
	return result;
}

export class TTSNode implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'TTS Node',
		name: 'ttsNode',
		group: ['transform'],
		version: 1,
		description: 'Converts input text to speech using KokoroTTS and outputs a WAV file',
		defaults: {
			name: 'TTS Node',
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		properties: [
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				default: '',
				placeholder: 'Enter text for TTS',
				description:
					'The text to convert into speech. Each new line is treated as a separate sentence.',
			},
			{
				displayName: 'Voice',
				name: 'voice',
				type: 'string',
				default: 'af_heart',
				description: 'The voice to use for TTS generation',
			},
			{
				displayName: 'Pause Duration (sec)',
				name: 'pauseDuration',
				type: 'number',
				default: 0.5,
				description: 'The duration of silence between sentences',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		// Get all input items
		const items = this.getInputData();

		// Load parameters (we assume the TTS model is loaded once for all items)
		// Voice and pause duration can be defined at the node level.
		const voice = this.getNodeParameter('voice', 0) as string;
		const pauseDuration = this.getNodeParameter('pauseDuration', 0) as number;

		// Load the TTS model (only once).
		let tts;
		try {
			tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-ONNX', {
				dtype: 'q8', // Options: "fp32", "fp16", "q8", "q4", "q4f16"
			});
		} catch (error: any) {
			throw new NodeOperationError(this.getNode(), 'Failed to load TTS model', {
				error,
			} as any);
		}

		// Process each input item.
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				// Get text parameter; each input item can have its own text.
				const text = this.getNodeParameter('text', itemIndex, '') as string;
				if (!text) {
					throw new NodeOperationError(this.getNode(), 'No text provided', { itemIndex });
				}

				// Split the text into sentences using newline.
				const sentences = text.split('\n').filter((sentence) => sentence.trim() !== '');

				// Set a default sampling rate; this may be updated with generated audio.
				let samplingRate = 22050;
				const audioChunks: Float32Array[] = [];

				// Generate a pause array (will be updated with the sampling rate if needed).
				let pauseSamples = new Float32Array(samplingRate * pauseDuration);

				// Process each sentence.
				for (let i = 0; i < sentences.length; i++) {
					const sentence = sentences[i];
					const rawAudio = await tts.generate(sentence, { voice: voice as any });
					// Update sampling rate from the generated audio.
					samplingRate = rawAudio.sampling_rate;
					// Recreate pause samples based on the current sampling rate.
					pauseSamples = new Float32Array(samplingRate * pauseDuration);

					// Append generated audio and pause to the chunks.
					audioChunks.push(rawAudio.audio);
					audioChunks.push(pauseSamples);
				}

				// Concatenate all audio chunks into one continuous Float32Array.
				const flattenedAudio = concatFloat32Arrays(audioChunks);

				// Convert the float32 audio samples to int16 PCM.
				const int16Samples = float32ToInt16(flattenedAudio);

				// Create the WAV file using the wavefile library.
				const wav = new wavefile.WaveFile();
				wav.fromScratch(1, samplingRate, '16', int16Samples);
				const wavBuffer = wav.toBuffer();

				// Attach the WAV file as binary data to the item.
				// n8n expects binary data to be base64 encoded.
				items[itemIndex].binary = {
					audio: {
						data: Buffer.from(wavBuffer).toString('base64'),
						mimeType: 'audio/wav',
						fileName: 'result.wav',
					},
				};

				// Optionally, you can also add info to json.
				items[itemIndex].json.ttsStatus = 'success';
			} catch (error) {
				if (this.continueOnFail()) {
					items.push({
						json: this.getInputData(itemIndex)[0].json,
						error,
						pairedItem: itemIndex,
					});
				} else {
					if (error.context) {
						error.context.itemIndex = itemIndex;
						throw error;
					}
					throw new NodeOperationError(this.getNode(), error, { itemIndex });
				}
			}
		}

		return [items];
	}
}
