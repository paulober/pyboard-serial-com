"use strict";

const { copySync } = require("fs-extra");

try {
    copySync(
        "./scripts", 
        "./dist/scripts", 
        {
            overwrite: true,
            preserveTimestamps: true
        })
} catch (err) {
    console.error(err);
}
