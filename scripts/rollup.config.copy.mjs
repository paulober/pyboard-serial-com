import copy from 'rollup-plugin-copy';

export default {
    input: 'scripts/dummy.js',
    plugins: [
        copy({
            targets: [
                { src: 'scripts/*.bin', dest: 'dist/scripts' },
            ],
            verbose: true
        })
    ],
    watch: {
        clearScreen: false
    }
};