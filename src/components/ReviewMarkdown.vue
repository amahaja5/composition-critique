<script setup>
import MarkdownIt from "markdown-it";
import { computed } from "vue";

const props = defineProps({
    content: {
        type: String,
        default: "",
    },
});

const markdown = new MarkdownIt({
    breaks: true,
    html: false,
    linkify: true,
    typographer: true,
});

const renderedContent = computed(() => markdown.render(props.content));
</script>

<template>
    <article class="review-markdown" v-html="renderedContent" />
</template>
