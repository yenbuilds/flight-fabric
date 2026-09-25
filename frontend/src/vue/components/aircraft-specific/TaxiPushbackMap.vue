<script setup>
import { ref, watch, onMounted } from 'vue';
import { renderPushbackMap } from '../../../aircraft/pushback-map.js';
const props = defineProps({ data: Object, fresh: Boolean });
const map = ref(null);
function draw() { if (map.value) renderPushbackMap(map.value, props.data, props.fresh); }
watch(() => [props.data, props.fresh], draw, { flush: 'post' });
onMounted(draw);
</script>

<template><svg ref="map" class="w-full" /></template>
