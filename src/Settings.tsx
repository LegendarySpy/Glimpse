import { useState, useEffect } from 'react';

const Settings = () => {
    const [serverUrl, setServerUrl] = useState('');
    const [status, setStatus] = useState('');

    useEffect(() => {
        const savedUrl = localStorage.getItem('transcription_server_url') || '';
        setServerUrl(savedUrl);
    }, []);

    const handleSave = () => {
        localStorage.setItem('transcription_server_url', serverUrl);
        setStatus('Saved!');
        setTimeout(() => setStatus(''), 2000);
    };

    return (
        <div className="min-h-screen bg-[#0a0a0a] text-white p-6 font-sans">
            <h1 className="text-2xl font-bold mb-6">Glimpse Settings</h1>

            <div className="space-y-6">
                <div className="space-y-2">
                    <label className="block text-sm font-medium text-gray-400">
                        Transcription Server URL
                    </label>
                    <input
                        type="text"
                        value={serverUrl}
                        onChange={(e) => setServerUrl(e.target.value)}
                        placeholder="ws://localhost:9000"
                        className="w-full bg-[#1a1a1a] border border-gray-800 rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-500 transition-colors"
                    />
                </div>

                <div className="space-y-2">
                    <label className="block text-sm font-medium text-gray-400">
                        Hotkeys
                    </label>
                    <div className="p-4 bg-[#1a1a1a] rounded border border-gray-800">
                        <div className="flex justify-between items-center text-sm">
                            <span className="text-gray-300">Toggle Overlay</span>
                            <span className="font-mono bg-gray-800 px-2 py-1 rounded text-xs">Option + Space</span>
                        </div>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">Hotkeys are currently fixed.</p>
                </div>

                <div className="pt-4 flex items-center justify-between">
                    <button
                        onClick={handleSave}
                        className="px-4 py-2 bg-white text-black rounded hover:bg-gray-200 transition-colors text-sm font-medium"
                    >
                        Save Changes
                    </button>
                    {status && (
                        <span className="text-green-500 text-sm animate-fade-in">
                            {status}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
};

export default Settings;
